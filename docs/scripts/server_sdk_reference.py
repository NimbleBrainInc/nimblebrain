"""Write the Server SDK API reference from the package's docstrings.

Run by the docs build (``bun run build`` and ``bun run dev``), never by hand-editing its
output: the pages under ``src/content/docs/server-sdk/reference/`` are generated on every
build and are not in git, so the reference cannot drift from the code it is built beside.

    uv run --project ../packages/server-sdk-py --frozen --all-extras --with griffe==2.4.1 \
        python scripts/server_sdk_reference.py

The package is read statically with griffe (nothing is imported or executed). Each page lists
one module's ``__all__``, in order of kind then name. The build fails when a public function or
class has no docstring, or a public name cannot be resolved, so an undocumented addition
stops the docs rather than shipping a blank entry.
"""

from __future__ import annotations

import importlib.util
import re
import sys
import tomllib
from pathlib import Path

import griffe

DOCS = Path(__file__).resolve().parent.parent
PACKAGE_DIR = DOCS.parent / "packages" / "server-sdk-py"
OUT = DOCS / "src" / "content" / "docs" / "server-sdk" / "reference"
PACKAGE = "nimblebrain_server_sdk"

#: (module path under the package, page slug, sidebar label, install line, one-line summary)
PAGES: list[tuple[str, str, str, str, str]] = [
    (
        "",
        "core",
        "nimblebrain_server_sdk",
        "nimblebrain-server-sdk",
        "Annotations, change announcements, the platform extensions, skills, listing rows, "
        "record ids, host resources and the error-contract middleware.",
    ),
    (
        "errors",
        "errors",
        "errors",
        "nimblebrain-server-sdk",
        "The service error contract: the codes, the typed error, and the tool results.",
    ),
    (
        "testing",
        "testing",
        "testing",
        "nimblebrain-server-sdk",
        "Checks a server's tests share: what a host sees of the server.",
    ),
    (
        "db",
        "db",
        "db",
        "nimblebrain-server-sdk[db]",
        "Tenant- and workspace-isolated Postgres access under row-level security.",
    ),
    (
        "db.testing",
        "db-testing",
        "db.testing",
        "nimblebrain-server-sdk[db]",
        "Test helpers for a server built on `SecuredDatabase`.",
    ),
    (
        "observability",
        "observability",
        "observability",
        "nimblebrain-server-sdk[observability]",
        "Metrics, structured logs and traces in one call.",
    ),
    (
        "outbox",
        "outbox",
        "outbox",
        "nimblebrain-server-sdk[outbox]",
        "The notification outbox a server records facts in, and the poll the host reads.",
    ),
]

KIND_ORDER = ["function", "class", "type alias", "attribute"]
KIND_TITLE = {
    "function": "Functions",
    "class": "Classes",
    "type alias": "Types",
    "attribute": "Constants",
}

_FENCE = re.compile(r"^(\s*)```")
_ROLE = re.compile(r":[a-z]+:`(~?)([^`<]+?)(?:\s*<[^`>]+>)?`")
_CODE_SPAN = re.compile(r"(`+)(.+?)\1")


def _inline(text: str) -> str:
    """One line of docstring prose as Markdown: roles and double backticks to code spans, and
    a ``<`` outside a code span escaped so Markdown does not read it as HTML."""

    def role(match: re.Match[str]) -> str:
        target = match.group(2).strip()
        return f"`{target.rsplit('.', 1)[-1] if match.group(1) else target}`"

    text = _ROLE.sub(role, text)
    text = re.sub(r"``(.+?)``", r"`\1`", text)
    parts: list[str] = []
    last = 0
    for span in _CODE_SPAN.finditer(text):
        parts.append(text[last : span.start()].replace("<", "&lt;"))
        parts.append(span.group(0))
        last = span.end()
    parts.append(text[last:].replace("<", "&lt;"))
    return "".join(parts)


def to_markdown(doc: str) -> str:
    """A docstring as Markdown.

    The docstrings are prose with reStructuredText habits: double-backtick literals,
    ``:func:`` style roles, and a literal block introduced by a line ending in ``::``. Fenced
    blocks pass through untouched.
    """
    lines = doc.expandtabs(4).splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        fence = _FENCE.match(line)
        if fence:
            indent = len(fence.group(1))
            out.append(line[indent:])
            i += 1
            while i < len(lines):
                body = lines[i]
                out.append(body[indent:] if body[:indent].strip() == "" else body)
                i += 1
                if _FENCE.match(body):
                    break
            continue
        if line.rstrip().endswith("::"):
            lead = len(line) - len(line.lstrip())
            j = i + 1
            while j < len(lines) and not lines[j].strip():
                j += 1
            block: list[str] = []
            while j < len(lines) and (
                not lines[j].strip() or len(lines[j]) - len(lines[j].lstrip()) > lead
            ):
                block.append(lines[j])
                j += 1
            while block and not block[-1].strip():
                block.pop()
            if block:
                prose = line.rstrip()[:-2].rstrip()
                if prose.strip():
                    out.append(_inline(prose + ":"))
                    out.append("")
                width = min(len(b) - len(b.lstrip()) for b in block if b.strip())
                out.append("```python")
                out.extend(b[width:] for b in block)
                out.append("```")
                out.append("")
                i = j
                continue
        out.append(_inline(line))
        i += 1
    return "\n".join(out).strip() + "\n"


def _load(package_dir: Path) -> griffe.Object:
    # `db` re-exports part of its API from pgbulkhead, so griffe reads that package too, from
    # wherever the SDK's environment installed it.
    spec = importlib.util.find_spec("pgbulkhead")
    if spec is None or spec.origin is None:
        raise SystemExit("pgbulkhead is not installed: run with the SDK's [db] extra")
    loader = griffe.GriffeLoader(
        search_paths=[str(package_dir / "src"), str(Path(spec.origin).parent.parent)]
    )
    loader.load("pgbulkhead")
    package = loader.load(PACKAGE)
    loader.resolve_aliases(external=True)
    if not isinstance(package, griffe.Object):
        raise SystemExit(f"{PACKAGE} did not load as a package")
    return package


def _target(member: griffe.Object | griffe.Alias) -> griffe.Object:
    return member.final_target if isinstance(member, griffe.Alias) else member


def _signature(name: str, obj: griffe.Object) -> str:
    if isinstance(obj, griffe.Function):
        prefix = "async def " if "async" in obj.labels else "def "
        return prefix + obj.signature(name=name)
    if isinstance(obj, griffe.Class):
        init = obj.all_members.get("__init__")
        init_function = _target(init) if init is not None else None
        if isinstance(init_function, griffe.Function):
            params = init_function.signature(return_type=False, name=name)
            params = re.sub(r"\(self,?\s*", "(", params, count=1)
            return "class " + params
        bases = ", ".join(str(base) for base in obj.bases)
        return f"class {name}({bases})" if bases else f"class {name}"
    if isinstance(obj, griffe.TypeAlias):
        return f"type {name} = {obj.value}"
    raw = getattr(obj, "value", None)
    value = str(raw) if raw is not None else "..."
    if len(value) > 240:
        value = value[:237] + "..."
    return f"{name} = {value}"


def _entry(name: str, obj: griffe.Object, problems: list[str], where: str) -> list[str]:
    lines = [f"### `{name}`", "", "```python", _signature(name, obj), "```", ""]
    if obj.docstring:
        lines += [to_markdown(obj.docstring.value), ""]
    elif obj.kind.value in ("function", "class"):
        problems.append(f"{where}.{name} has no docstring")
    if isinstance(obj, griffe.Class):
        for member_name, member in sorted(obj.all_members.items()):
            if member_name.startswith("_"):
                continue
            try:
                target = _target(member)
            except griffe.AliasResolutionError:
                continue
            if not target.docstring or target.kind.value not in ("function", "attribute"):
                continue
            is_method = isinstance(target, griffe.Function) and "property" not in target.labels
            shown = (
                _signature(member_name, target)
                if is_method
                else f"{member_name}: {getattr(target, 'annotation', None) or getattr(target, 'returns', None) or 'Any'}"
            )
            lines += [
                f"#### `{name}.{member_name}`",
                "",
                "```python",
                shown,
                "```",
                "",
                to_markdown(target.docstring.value),
                "",
            ]
    return lines


def main(
    package_dir: Path = PACKAGE_DIR,
    out: Path = OUT,
    pages: list[tuple[str, str, str, str, str]] = PAGES,
) -> int:
    """Write the reference for the package under ``package_dir`` to ``out``.

    The defaults are the SDK and the docs site. A test passes a fixture package and a
    temporary directory.
    """
    pyproject = (package_dir / "pyproject.toml").read_text(encoding="utf-8")
    version = tomllib.loads(pyproject)["project"]["version"]
    package = _load(package_dir)
    problems: list[str] = []
    out.mkdir(parents=True, exist_ok=True)
    for stale in out.glob("*.md"):
        stale.unlink()

    index_rows: list[str] = []
    for order, (path, slug, label, install, summary) in enumerate(pages, start=1):
        module: griffe.Object = package
        for part in filter(None, path.split(".")):
            module = _target(module.members[part])
        dotted = PACKAGE + (f".{path}" if path else "")
        names = [str(getattr(n, "name", n)) for n in (module.exports or [])]
        if not names:
            problems.append(f"{dotted} has no __all__")
        by_kind: dict[str, list[tuple[str, griffe.Object]]] = {}
        for name in names:
            try:
                obj = _target(module.members[name])
            except (KeyError, griffe.AliasResolutionError) as exc:
                problems.append(f"{dotted}.{name} cannot be resolved ({type(exc).__name__})")
                continue
            if obj.kind.value == "module":
                continue
            by_kind.setdefault(obj.kind.value, []).append((name, obj))

        body = [
            "---",
            f"title: {label}",
            f"description: API reference for {dotted}, generated from its docstrings.",
            "sidebar:",
            f"  order: {order}",
            "---",
            "",
            f"`{dotted}` · install `{install}` · version {version}",
            "",
            "```python",
            f"from {dotted} import {', '.join(sorted(names)[:3])}",
            "```",
            "",
        ]
        body += [to_markdown(module.docstring.value) if module.docstring else summary, ""]
        for kind in KIND_ORDER:
            entries = sorted(by_kind.get(kind, []), key=lambda e: e[0].lower())
            if not entries:
                continue
            body += [f"## {KIND_TITLE[kind]}", ""]
            for name, obj in entries:
                body += _entry(name, obj, problems, dotted)
        (out / f"{slug}.md").write_text("\n".join(body).rstrip() + "\n", encoding="utf-8")
        index_rows.append(
            f"| [`{dotted}`](/server-sdk/reference/{slug}/) | `{install}` | {summary} |"
        )

    index = [
        "---",
        "title: API reference",
        "description: Every public name in nimblebrain-server-sdk, generated from the package's docstrings.",
        "sidebar:",
        "  order: 0",
        "  label: Overview",
        "---",
        "",
        f"Every public name in `nimblebrain-server-sdk` {version}, one page per module. The pages "
        "are generated from the package's docstrings each time this site is built, so they "
        "describe the code on the `main` branch; a name added since the latest release on PyPI "
        "is marked in the [changelog](https://github.com/NimbleBrainInc/nimblebrain/blob/main/packages/server-sdk-py/CHANGELOG.md) "
        "under Unreleased.",
        "",
        "| Module | Install | What it holds |",
        "|---|---|---|",
        *index_rows,
        "",
        "A name not listed here, or one that starts with an underscore, is not part of the API "
        "and may change in any release. See [Compatibility and stability](/server-sdk/compatibility/).",
        "",
    ]
    (out / "index.md").write_text("\n".join(index), encoding="utf-8")

    for problem in problems:
        print(f"error: {problem}", file=sys.stderr)
    if problems:
        return 1
    print(f"wrote {len(pages) + 1} reference pages for {PACKAGE} {version} to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
