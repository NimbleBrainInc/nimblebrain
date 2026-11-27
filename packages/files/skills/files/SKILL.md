---
name: files
description: How to find, read, write, file and tidy the person's files with the files__* tools
metadata:
  nimblebrain:
    loading-strategy: dynamic
    priority: 50
    tool-affinity:
      - files__*
    triggers:
      - "file"
      - "files"
      - "folder"
      - "document"
      - "attachment"
      - "upload"
      - "pdf"
      - "spreadsheet"
allowed-tools: files__list files__search files__info files__read files__create files__tag files__move files__create_folder
---

# Files

The person's files belong to the workspace you are in and are theirs alone. You never name a
workspace or an owner to reach them: every `files__*` call is already walled to this
workspace and this person. Never ask which workspace a file is in, and never use
`nb__search` to find a file.

## Find a file

- **`files__search {query}`** when you know part of its name, description or a tag. It
  matches case-insensitively and answers the newest first.
- **`files__list`** to browse or filter: by `folderId` (`"root"` is the top level; add
  `recursive: true` for everything below), `kinds` (`image`, `document`, `data`, `font`,
  `other`), `sources` (`chat` attached in a chat, `agent` written by an agent, `app` or
  `manual` uploaded), `conversationId`, `runId`, `createdAfter`/`createdBefore`, `tags`,
  `mimeType` (a prefix such as `image/`). `total` and `facets` count every match.
- A list answers at most `limit` files (default 20). When `nextCursor` is not null, pass it
  back as `cursor` with the same filters and sort, unchanged, for the next page.
- A file's id is the `<id>` of its `files://<id>` URI.

## Read a file

- **`files__read {id}`** answers the file's text for text, code, JSON, Markdown, CSV, HTML,
  XML, YAML, PDF, DOCX and XLSX (its first sheet, as CSV). `truncated: true` means the text
  stops at the bound; pass `maxBytes` to ask for less.
- **For a long PDF, read it by page**: `files__read {id, pages: [4, 5, 6]}`, at most 10 pages a
  call. Use it for pages past a truncated text, or when the person asks about a page.
- An image, a font, an archive or other binary has no text: `read` answers its record with
  `extractedText: null`. An image the person attached reaches you with their message; do not
  read it again here.
- **`files__info {id}`** answers the record alone (name, type, size, tags, folder, where it
  came from), never the content.

## Write a file

- **`files__create {manifest, body, encoding}`**. For anything you compose yourself
  (Markdown, code, CSV, JSON, prose) pass `encoding: "text"` and the content verbatim. Use
  the default base64 only for bytes you already hold encoded, in the standard padded
  alphabet. The body is at most 4 MiB.
- `manifest` is `{filename, mimeType, folder?, tags?, description?}`. A generic or empty
  `mimeType` for a known text extension (`.md`, `.py`, `.typ`…) is recorded as that
  extension's text type. `folder` is a path such as `Reports/Q3`; missing folders are made.
- A file's content never changes: to revise one, create the new version and delete the old
  one if the person wants it gone.

## Organize

- **`files__tag {id, add, remove}`** to label files.
- **`files__move {ids, folderId}`** moves every id or none.
- **`files__create_folder`**, **`files__update_folder`** (rename with `manifest.name`, move
  with `manifest.parentId`) and **`files__delete_folder`** (only an empty folder). Folder
  names are unique beside each other, ignoring case.
- **`files__delete {id}`** removes a file and its content for good. Confirm with the person
  first unless they asked for it plainly.

## Errors

Every error is `{code, error}`; decide on `code`. `file_not_found` and `folder_not_found`
mean the id names nothing of this person's here (check the id with `files__search`);
`conflict` names what stands in the way; `not_paged` means `pages` was given for a file with
no pages; `too_large` and `type_not_allowed` mean the file cannot be stored as asked.
