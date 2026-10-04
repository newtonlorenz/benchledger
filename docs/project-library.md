# Visual project library and build handoff

Projects opens as a gallery of finished-product images. Use **List** for
the project register. **All projects** includes active, completed and archived
projects; the other filters, search, pins and sorting help find the next build. View
choices, pins and recent projects stay in this browser and are separate between
the sample and connected workspaces.

The connected client reads every page of the project library rather than
stopping at the bounded workspace preview, and includes archived projects in
the gallery. A failed or non-advancing page fails the refresh visibly; it never reports a partial read as the whole library.
Pagination is read-committed, so concurrent project changes can affect later
pages. Refresh before making a build decision.

## Choose the finished-product image

In a project's **Files** tab, upload a PNG, JPEG or WebP, then use
**Project image → Choose project image**. Select the image and identify it as a
**Design render**,
**Reference image** or **Built-product photo**. Add a description for people who
cannot see the image. The selection belongs to the current project revision;
an image may also belong to a current work-item revision in that project.

Images are limited to 20 MiB. The gallery loads visible images through the
authenticated artifact download and verifies their SHA-256 hashes before
display. It does not fetch an external image URL. Unsupported, historical,
retired or hash-mismatched files cannot become a current product image.
Selections retain optimistic versions and append-only history. Starting a new
project revision requires a new selection; it does not silently inherit an old
render. A render or a photo never changes manufacturing or stock evidence.

## Continue into a build

Use **Start build** on a gallery card to open the current revision's
**Build steps** tab. The handoff shows the recorded plan, notes, unresolved checks
and current files grouped into 3D printing, PCB/fabrication, components/firmware
and instructions. It includes current work-item files. Historical, unbound and
retired files remain accessible in the read-only **All files** view, outside the
current handoff.

For a print, use **Download 3MF** on the card or download a named file in the
handoff. Open the downloaded 3MF in Bambu Studio or the matching slicer. Review
the printer, material, supports and plate settings, and slice as needed. The
file format alone does not prove that a file is a Bambu project, already sliced,
compatible with the selected printer or approved for manufacture. STL files
need slicer setup. Every download checks the recorded SHA-256 hash.

For a PCB or component, download its CAD, fabrication exports, toolpaths,
firmware and instructions, then continue in the matching tool. Review the
recorded workstreams and physical checks before manufacturing. Downloading or
opening this view never operates equipment, flashes hardware or changes stock.

## Prepare the same view with MCP

1. Discover capabilities and read the current project and work-item revisions.
2. Attach the authorised final-product image and build files to those exact
   revisions using the approved artifact transfer workflow. A metadata-only
   host cannot upload bytes; use the browser when necessary.
3. Call `read_project_presentation` to get `{ presentation }` and its current
   `version` (use zero when null), then select the cover:

```json
{
  "projectId": "example-project",
  "projectRevisionId": "example-revision",
  "presentation": {
    "expectedVersion": 0,
    "coverArtifactId": "example-render",
    "imageKind": "render",
    "caption": "Finished enclosure with its controller and lid"
  }
}
```

Pass this to `save_project_presentation` with one stable idempotency key.
Use `coverArtifactId: null` to clear the selection. Writes require the current
project revision, project-write scope and allowed project ancestry. Reads
invalidate an unavailable cover while retaining its version, hash and history.

4. Use `save_build_plan` for exact parts, attached file IDs, print plates and
   recorded checks. Use workstreams and the assembly steps for electronics or
   other fabrication. Record missing checks; do not declare physical approval
   from a digital plan.
5. Read back `list_project_library`, following `nextCursor` until absent, and
   refresh Projects. The person can now recognise the project and retrieve
   its build files.

`list_project_library` accepts `status: active | archived | all`, `limit` from
1 to 100 (25 by default) and its opaque continuation cursor. Each entry has
the current revision, requirements and stock gaps, project/work-item artifact
metadata, `presentation` and `buildPlan`. It returns metadata, not image bytes.
Project-scoped tokens see only permitted projects; this read does not expose
workspace-global inventory or supplier records.

HTTP offers `GET /api/v1/project-library` and `GET`/`PUT
/api/v1/projects/{projectId}/revisions/{revisionId}/presentation`. Presentation
GET returns the record or null directly; MCP wraps it as `{ presentation }`.
PUT follows the existing audited mutation envelope, CSRF/browser protection,
project scope and idempotency rules. Retained selections are available through
`GET .../presentation/history` and `read_project_presentation_history`.

This feature uses the existing workflow record/history tables and needs no
database schema migration. Older services retain their existing bounded
workspace behaviour and do not offer the presentation editor. Rollback removes
the handoff and library build-plan metadata while preserving existing images,
plans, artifacts, inventory and manufacturing status.
