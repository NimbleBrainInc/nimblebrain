"""Server side of the MCP Skills extension (SEP-2640, `io.modelcontextprotocol/skills`).

A skill is a set of files rooted at a `SKILL.md`. Each file is served as a
resource at `skill://<skill-path>/<file-path>`; `skills/list` and `skills/get`
return each skill's entry: the `SKILL.md` URI, its frontmatter verbatim, and a
`{uri, digest, size}` manifest of every file. Digests and sizes are computed
once, at construction, over the exact bytes `resources/read` serves, and every
check the spec places on a skill (name rules, name equals the last URI segment,
file paths inside the skill) runs at construction so a bad skill fails at
import, not on a host's first read.

`SkillsCatalog` holds that core and knows no server framework.
`SkillsExtension` binds it to FastMCP (`mcp.add_extension(...)`), and
`MCPServerSkillsExtension` to the `mcp` SDK's `MCPServer(extensions=[...])`.
The shapes follow FastMCP's `SkillsExtension` and the `mcp` SDK's `Skills`
extension, both unreleased, so this module can be deleted once they ship.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import re
import warnings
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from functools import cached_property
from os import PathLike
from pathlib import Path, PurePosixPath
from typing import Any

import yaml
from fastmcp.resources import BinaryResource as FastMCPBinaryResource
from fastmcp.resources import TextResource as FastMCPTextResource
from fastmcp.server.extensions import MethodBinding as FastMCPMethodBinding
from fastmcp.server.extensions import ServerExtension
from mcp.server.extension import Extension, ResourceBinding
from mcp.server.extension import MethodBinding as MCPMethodBinding
from mcp.server.mcpserver.resources import BinaryResource, TextResource
from mcp.shared.exceptions import MCPError
from mcp_types import INVALID_PARAMS, PaginatedRequestParams, RequestParams
from mcp_types.version import MODERN_PROTOCOL_VERSIONS
from pydantic import AnyUrl, ValidationError

SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills"
SKILL_MANIFEST = "SKILL.md"

# Per-skill limits every conforming host accepts (SEP-2640 "Limits"). Servers
# SHOULD NOT exceed them, so exceeding one warns rather than fails.
MAX_RESOURCES_PER_SKILL = 512
MAX_TOTAL_SIZE_PER_SKILL = 16 * 1024 * 1024

# Agent Skills `name`: 1-64 lowercase letters, digits, and hyphens, with no
# leading, trailing, or doubled hyphen.
_NAME_PATTERN = re.compile(r"^(?!.*--)[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$")
_FRONTMATTER = re.compile(r"^---\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)", re.DOTALL)


class _FrontmatterLoader(yaml.SafeLoader):
    """PyYAML's safe loader, narrowed toward YAML 1.2 for the scalars that differ.

    Hosts re-parse `SKILL.md` and compare its frontmatter field by field with
    the entry, typically with a YAML 1.2 parser. Under YAML 1.1 (PyYAML's
    default) `yes`/`no`/`on`/`off` are booleans and `2026-01-01` is a date,
    which renders differently in JSON than the string a 1.2 parser yields, so
    the entry would fail the host's comparison. Only `true`/`false` resolve to
    booleans here, and timestamps stay strings.
    """


_FrontmatterLoader.yaml_implicit_resolvers = {
    first: [
        (tag, regexp)
        for tag, regexp in resolvers
        if tag not in ("tag:yaml.org,2002:bool", "tag:yaml.org,2002:timestamp")
    ]
    for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
_FrontmatterLoader.add_implicit_resolver(
    "tag:yaml.org,2002:bool",
    re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$"),
    list("tTfF"),
)


def _parse_frontmatter(text: str, where: str) -> dict[str, Any]:
    match = _FRONTMATTER.match(text.removeprefix("﻿"))
    if match is None:
        raise ValueError(f"{where}: SKILL.md must begin with a `---` YAML frontmatter block")
    try:
        data = yaml.load(match.group(1), Loader=_FrontmatterLoader)
    except yaml.YAMLError as exc:
        raise ValueError(f"{where}: SKILL.md frontmatter is not valid YAML: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError(f"{where}: SKILL.md frontmatter must be a YAML mapping")
    try:
        json.dumps(data, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{where}: SKILL.md frontmatter must be representable as JSON") from exc
    return data


def _check_segments(value: str, what: str, where: str) -> tuple[str, ...]:
    segments = tuple(value.split("/"))
    for segment in segments:
        if segment in ("", ".", "..") or "\\" in segment or segment != segment.strip():
            raise ValueError(f"{where}: invalid {what} {value!r}")
    return segments


def _check_uri_verbatim(uri: str, where: str) -> None:
    # Resource URIs pass through pydantic's `AnyUrl`, which percent-encodes
    # spaces and non-ASCII. A served URI that differs from the listed one
    # breaks the manifest, so such a name fails here instead.
    try:
        normalized = str(AnyUrl(uri))
    except ValidationError as exc:
        raise ValueError(f"{where}: {uri!r} is not a valid URI") from exc
    if normalized != uri:
        raise ValueError(f"{where}: {uri!r} would be served as {normalized!r}; rename the file")


def _mime_type(file_path: str, is_text: bool) -> str:
    if file_path.endswith(".md"):
        return "text/markdown"
    guessed, _ = mimetypes.guess_type(file_path)
    if guessed:
        return guessed
    return "text/plain" if is_text else "application/octet-stream"


@dataclass(frozen=True)
class SkillFile:
    """One file of a skill, with the digest and size of the bytes it is served as."""

    uri: str
    path: str
    data: bytes
    text: str | None
    """The content as served in a text resource, or None when it is served as a blob."""
    mime_type: str

    @cached_property
    def digest(self) -> str:
        return "sha256:" + hashlib.sha256(self.data).hexdigest()

    @property
    def size(self) -> int:
        return len(self.data)


class SkillDefinition:
    """A skill's files, validated against SEP-2640 at construction.

    `path` is the skill path (`tasks`, or `acme/billing/refunds`); its last
    segment must equal the frontmatter `name`. `files` maps each file's path
    relative to the skill root to its content and must include `SKILL.md`. Use
    this directly for a skill whose files are generated or packaged; use
    `from_directory` for a skill that is a directory on disk.

    Content that decodes as UTF-8 is served as a text resource, anything else
    as a blob. Either way the digest covers the raw bytes, which is what a host
    hashes after decoding the text or the base64.
    """

    def __init__(
        self,
        path: str,
        files: Mapping[str, str | bytes],
        *,
        scheme: str = "skill",
    ) -> None:
        where = f"skill {path!r}"
        self.path = "/".join(_check_segments(path, "skill path", where))
        self.uri = f"{scheme}://{self.path}/{SKILL_MANIFEST}"
        if SKILL_MANIFEST not in files:
            raise ValueError(f"{where}: files must include {SKILL_MANIFEST}")

        built: dict[str, SkillFile] = {}
        for file_path in sorted(files):
            _check_segments(file_path, "file path", where)
            content = files[file_path]
            data = content.encode("utf-8") if isinstance(content, str) else bytes(content)
            try:
                text: str | None = data.decode("utf-8")
            except UnicodeDecodeError:
                text = None
            uri = f"{scheme}://{self.path}/{file_path}"
            _check_uri_verbatim(uri, where)
            built[file_path] = SkillFile(
                uri=uri,
                path=file_path,
                data=data,
                text=text,
                mime_type=_mime_type(file_path, text is not None),
            )
        self.files: tuple[SkillFile, ...] = tuple(built.values())

        manifest = built[SKILL_MANIFEST]
        if manifest.text is None:
            raise ValueError(f"{where}: {SKILL_MANIFEST} must be UTF-8 text")
        self.frontmatter = _parse_frontmatter(manifest.text, where)
        name = self.frontmatter.get("name")
        if not isinstance(name, str) or not _NAME_PATTERN.fullmatch(name):
            raise ValueError(
                f"{where}: frontmatter `name` must be 1-64 lowercase letters, digits, or "
                "hyphens, with no leading, trailing, or consecutive hyphen"
            )
        if name != self.path.rsplit("/", 1)[-1]:
            raise ValueError(
                f"{where}: frontmatter name {name!r} must equal the last segment of the "
                f"skill path (SEP-2640: {self.uri} names the skill "
                f"{self.path.rsplit('/', 1)[-1]!r})"
            )
        description = self.frontmatter.get("description")
        if not isinstance(description, str) or not description.strip():
            raise ValueError(f"{where}: frontmatter `description` must be a non-empty string")
        self.name: str = name
        self.description: str = description

        total = sum(f.size for f in self.files)
        if len(self.files) > MAX_RESOURCES_PER_SKILL or total > MAX_TOTAL_SIZE_PER_SKILL:
            warnings.warn(
                f"{where} has {len(self.files)} files and {total} bytes, beyond the SEP-2640 "
                f"limits ({MAX_RESOURCES_PER_SKILL} files, {MAX_TOTAL_SIZE_PER_SKILL} bytes); "
                "hosts may decline to load it",
                stacklevel=2,
            )

    @classmethod
    def from_directory(
        cls,
        directory: str | PathLike[str],
        *,
        path: str | None = None,
        scheme: str = "skill",
    ) -> SkillDefinition:
        """Load every file under `directory` (dotfiles and `__pycache__` excluded).

        `path` defaults to the directory's name, which the Agent Skills
        specification requires to equal the skill's `name`.
        """
        root = Path(directory)
        if not (root / SKILL_MANIFEST).is_file():
            raise ValueError(f"{root}: no {SKILL_MANIFEST} in skill directory")
        files: dict[str, bytes] = {}
        for file in sorted(root.rglob("*")):
            rel = PurePosixPath(file.relative_to(root).as_posix())
            if not file.is_file() or any(
                part.startswith(".") or part == "__pycache__" for part in rel.parts
            ):
                continue
            files[str(rel)] = file.read_bytes()
        return cls(path if path is not None else root.name, files, scheme=scheme)

    def entry(self) -> dict[str, Any]:
        """This skill's `skills/list` / `skills/get` entry, in wire form."""
        return {
            "uri": self.uri,
            "frontmatter": self.frontmatter,
            "resources": [{"uri": f.uri, "digest": f.digest, "size": f.size} for f in self.files],
        }

    def resource_metadata(self, file: SkillFile) -> dict[str, Any]:
        """`name`/`description`/`mimeType` for a file's resource.

        `SKILL.md` takes its name and description from the frontmatter
        (SEP-2640 "Resource Metadata"); other files are named by their path.
        """
        if file.path == SKILL_MANIFEST:
            return {"name": self.name, "description": self.description, "mime_type": file.mime_type}
        return {
            "name": f"{self.name}/{file.path}",
            "description": None,
            "mime_type": file.mime_type,
        }


SkillInput = SkillDefinition | str | PathLike[str]


class ListSkillsParams(PaginatedRequestParams):
    """Params of `skills/list`."""


class GetSkillParams(RequestParams):
    """Params of `skills/get`."""

    uri: str


class SkillsCatalog:
    """The skills a server serves, and the `skills/list` / `skills/get` answers.

    Accepts `SkillDefinition`s and skill directories (a path is loaded with
    `SkillDefinition.from_directory`). Two skills with the same URI, or two
    files at one URI with different bytes, are rejected here.
    """

    def __init__(self, skills: Iterable[SkillInput]) -> None:
        by_uri: dict[str, SkillDefinition] = {}
        files: dict[str, SkillFile] = {}
        for item in skills:
            skill = (
                item if isinstance(item, SkillDefinition) else SkillDefinition.from_directory(item)
            )
            if skill.uri in by_uri:
                raise ValueError(f"two skills are served at {skill.uri}")
            by_uri[skill.uri] = skill
            # A nested skill's files also belong to the skill enclosing it, so
            # the same URI may be listed twice; it must be the same bytes.
            for file in skill.files:
                seen = files.setdefault(file.uri, file)
                if seen.data != file.data:
                    raise ValueError(f"{file.uri} is served with two different contents")
        if not by_uri:
            raise ValueError("a skills extension needs at least one skill")
        self.skills: dict[str, SkillDefinition] = dict(sorted(by_uri.items()))

    def unique_files(self) -> list[tuple[SkillDefinition, SkillFile]]:
        """Every served file once, with the skill whose metadata describes it."""
        out: dict[str, tuple[SkillDefinition, SkillFile]] = {}
        for skill in self.skills.values():
            for file in skill.files:
                # A file that is some skill's SKILL.md takes that skill's metadata.
                if file.uri not in out or file.uri == skill.uri:
                    out[file.uri] = (skill, file)
        return [out[uri] for uri in sorted(out)]

    def list_skills(self, params: ListSkillsParams, protocol_version: str | None) -> dict[str, Any]:
        # Every entry fits one page, so no cursor is ever issued; any cursor is invalid.
        if params.cursor is not None:
            raise MCPError(code=INVALID_PARAMS, message=f"Unknown cursor: {params.cursor}")
        result = {"skills": [skill.entry() for skill in self.skills.values()]}
        return _with_cache_attributes(result, protocol_version)

    def get_skill(self, params: GetSkillParams, protocol_version: str | None) -> dict[str, Any]:
        skill = self.skills.get(params.uri)
        if skill is None:
            raise MCPError(code=INVALID_PARAMS, message=f"Unknown skill URI: {params.uri}")
        return _with_cache_attributes({"skill": skill.entry()}, protocol_version)


def _with_cache_attributes(result: dict[str, Any], protocol_version: str | None) -> dict[str, Any]:
    # From 2026-07-28 both results are cacheable results (SEP-2549), whose
    # `ttlMs`/`cacheScope` are required; earlier versions do not define them.
    # The values are the `mcp` SDK's defaults: immediately stale, never shared.
    if protocol_version in MODERN_PROTOCOL_VERSIONS:
        return {**result, "ttlMs": 0, "cacheScope": "private"}
    return result


class SkillsExtension(ServerExtension):
    """SEP-2640 skills for a FastMCP server.

    ```python
    mcp.add_extension(SkillsExtension([Path(__file__).parent / "skills" / "tasks"]))
    ```

    Registering it declares `io.modelcontextprotocol/skills`, serves
    `skills/list` and `skills/get`, and registers every skill file as a resource.
    """

    identifier = SKILLS_EXTENSION_ID

    def __init__(self, skills: Iterable[SkillInput]) -> None:
        self.catalog = SkillsCatalog(skills)

    def _bind(self, server: Any) -> None:
        # FastMCP's `ServerExtension` has no resource contribution, and the
        # resources must exist exactly when the extension does, so they are
        # registered as the server binds the extension (`add_extension`).
        super()._bind(server)
        for skill, file in self.catalog.unique_files():
            meta = skill.resource_metadata(file)
            if file.text is not None:
                server.add_resource(
                    FastMCPTextResource(uri=AnyUrl(file.uri), text=file.text, **meta)
                )
            else:
                server.add_resource(
                    FastMCPBinaryResource(uri=AnyUrl(file.uri), data=file.data, **meta)
                )

    def methods(self) -> Sequence[FastMCPMethodBinding]:
        catalog = self.catalog
        return (
            FastMCPMethodBinding(
                method="skills/list",
                params_type=ListSkillsParams,
                handler=lambda ctx, params: _answer(catalog.list_skills, ctx, params),
            ),
            FastMCPMethodBinding(
                method="skills/get",
                params_type=GetSkillParams,
                handler=lambda ctx, params: _answer(catalog.get_skill, ctx, params),
            ),
        )


class MCPServerSkillsExtension(Extension):
    """SEP-2640 skills for an `mcp` SDK `MCPServer`.

    ```python
    server = MCPServer("name", extensions=[MCPServerSkillsExtension([skill_dir])])
    ```
    """

    identifier = SKILLS_EXTENSION_ID

    def __init__(self, skills: Iterable[SkillInput]) -> None:
        self.catalog = SkillsCatalog(skills)

    def resources(self) -> Sequence[ResourceBinding]:
        bindings: list[ResourceBinding] = []
        for skill, file in self.catalog.unique_files():
            meta = skill.resource_metadata(file)
            if file.text is not None:
                resource = TextResource(uri=file.uri, text=file.text, **meta)
            else:
                resource = BinaryResource(uri=file.uri, data=file.data, **meta)
            bindings.append(ResourceBinding(resource=resource))
        return bindings

    def methods(self) -> Sequence[MCPMethodBinding]:
        catalog = self.catalog
        return (
            MCPMethodBinding(
                method="skills/list",
                params_type=ListSkillsParams,
                handler=lambda ctx, params: _answer(catalog.list_skills, ctx, params),
            ),
            MCPMethodBinding(
                method="skills/get",
                params_type=GetSkillParams,
                handler=lambda ctx, params: _answer(catalog.get_skill, ctx, params),
            ),
        )


async def _answer(method: Any, ctx: Any, params: Any) -> dict[str, Any]:
    return method(params, getattr(ctx, "protocol_version", None))


__all__ = [
    "MAX_RESOURCES_PER_SKILL",
    "MAX_TOTAL_SIZE_PER_SKILL",
    "SKILLS_EXTENSION_ID",
    "GetSkillParams",
    "ListSkillsParams",
    "MCPServerSkillsExtension",
    "SkillDefinition",
    "SkillFile",
    "SkillsCatalog",
    "SkillsExtension",
]
