# Creator AI

Remote [MCP](https://modelcontextprotocol.io) server that lets an AI assistant work with Canvas LMS grading. Runs on Cloudflare Workers. One file, zero dependencies.

**Tools:** `list_courses`, `list_assignments`, `get_assignment` (with rubric), `list_submissions` (marking-queue filter), `get_submission`, `get_course_grades`, `get_student_grades`, `grade_submission` (writes), `add_submission_comment` (writes).

## Deploy (browser only)

1. In Canvas: **Account → Settings → New Access Token**.
2. Push this repo to GitHub.
3. Cloudflare dashboard: **Workers & Pages → Create → Import a repository** → pick this repo → Deploy.
4. Worker → **Settings → Variables and Secrets** → add as *Secrets*:

| Name | Value |
|---|---|
| `CANVAS_BASE_URL` | your Canvas URL, no trailing slash |
| `CANVAS_TOKEN` | the Canvas token |
| `MCP_KEY` | long random string protecting the endpoint |
| `READ_ONLY` | optional, `true` blocks grading/comments |

5. Add a custom connector in your AI app pointing at `https://<worker>.workers.dev/mcp?key=<MCP_KEY>`.

Prefer not to use Git? Paste `src/index.js` into a new Worker in the dashboard editor instead.

## Security

- The key sits in the URL because some AI apps cannot send headers. Treat the URL like a password. Clients that can send headers may use `Authorization: Bearer <MCP_KEY>`.
- Grading tools write to Canvas. Use `READ_ONLY=true` while testing.

## Roadmap

OAuth per user, courses/modules tools, bulk grading.
