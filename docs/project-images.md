# Project images

Projects opens in **Gallery** so a render or photo can identify each build.
Choose **List** for compact rows with thumbnails; the layout is remembered in
this browser, separately for sample and private workspaces. Search, filters,
sort, pins and next actions work in both layouts. Archived projects remain in
their separate view.

## Choose an image

1. Open a project and go to **Files**. Upload a PNG, JPEG or WebP if the image is
   not already attached. It must be no larger than **20 MiB** and belong to the
   current project revision or a current workstream revision in that project.
2. In **Project image**, choose **Choose project image** or **Change project
   image**. Select the file and review its preview.
3. Set **Image represents** to **Design render**, **Reference image** or
   **Built-product photo**. Add an **Image description** to explain what is shown;
   it supplies the image's alternative text.
4. Choose **Save project image**, then return to Projects. Selecting **No project
   image** removes the cover without deleting its file.

Images are selected deliberately from attached files. BenchLedger does not
automatically render CAD files or create a cover from an unrelated attachment.
A reference or render remains distinguishable from a photograph of a build.
None of these images establishes dimensions, manufacturing settings, usable
stock or physical readiness.

Gallery preserves the whole image within its frame. Opening the project lands
on Overview, where the same selected image appears with the project notes and
next action. Parts and Build keep their working content first; a file preview
always uses the selected artifact, not this cover. Downloads use the existing
authenticated artifact route, verify SHA-256 and stay within the 20 MiB limit
before displaying bytes. An unavailable image offers **Retry image**; missing
covers offer **Choose image**. No image is sent to a third-party viewer.

## Revision and access rules

The presentation belongs to one exact project revision. Its selected file must
be active and attached to that revision, or to the current revision of a
workstream in the same project. Historical, retired, wrong-project and
hash-mismatched files cannot supply the current cover. A stale selection is
returned with a warning and no active cover; retained history preserves the
original record. A new project revision needs its own selection.

Changing a cover uses the current presentation version and a stable command
identity. A version conflict requires a fresh read. Retry an unacknowledged
save with the original payload and identity; a saved choice remains committed
if its subsequent refresh fails. Image selection does not change project
lifecycle, stock, reservations or build plans.

## HTTP and MCP

Check advertised capabilities before calling these operations. HTTP paths below
are relative to `/api/v1` and use the existing read/write authentication and
project allow-list rules. The final column gives each MCP scope.

| Operation | HTTP | MCP | MCP scope |
| --- | --- | --- | --- |
| Browse project metadata and images | `GET /project-library` | `list_project_library` | `projects:read` |
| Read the selected image | `GET /projects/{projectId}/revisions/{revisionId}/presentation` | `read_project_presentation` | `projects:read` |
| Save or clear the selection | `PUT /projects/{projectId}/revisions/{revisionId}/presentation` | `save_project_presentation` | `projects:write` |
| Read retained selections | `GET /projects/{projectId}/revisions/{revisionId}/presentation/history` | `read_project_presentation_history` | `projects:read` |

The library accepts `status: active | archived | all`, defaults to `active`,
and includes completed projects in that active set. `limit` defaults to 25 and
is bounded to 1–100. Follow every returned `nextCursor` with the same status and
account scope. Results include only allowed projects with their current
revision, requirements/readiness, artifact metadata and presentation; they
contain neither image bytes nor global inventory or offers.

Presentation input contains `expectedVersion` (0 for the first selection),
`coverArtifactId` (or `null` to clear), `imageKind` (`render`, `reference` or
`built_photo`) and an optional `caption` of up to 1,000 characters. The service
records the selected artifact's SHA-256, author, timestamp and next version.
HTTP sends those fields as the body and uses `Idempotency-Key`; MCP sends them
inside `presentation` alongside `projectId` and `projectRevisionId`, using the
host command key. History uses bounded `limit` and cursor pages. Existing scoped
artifact-transfer rules still apply to uploading or downloading the file itself.

See [agent quickstart](agent-quickstart.md), [capability map](capability-map.md)
and the [MCP guide](../apps/mcp/QUICKSTART.md) for discovery and transfer details.
