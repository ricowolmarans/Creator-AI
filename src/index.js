/**
 * Creator AI (academy-mcp) v0.1 - remote MCP server for Canvas LMS
 * Runs on Cloudflare Workers. Zero dependencies, single file.
 * Paste into the Cloudflare dashboard editor and deploy.
 *
 * Variables / secrets (Settings -> Variables and Secrets):
 *   CANVAS_BASE_URL  e.g. https://canvas.launchpad-studio.co.za
 *   CANVAS_TOKEN     Canvas access token (secret)
 *   MCP_KEY          secret that protects this endpoint (secret)
 *   READ_ONLY        optional, "true" blocks all grading/comment writes
 *
 * Endpoint: POST https://<your-worker>/mcp?key=<MCP_KEY>
 *           (or send header Authorization: Bearer <MCP_KEY>)
 */

const SERVER_INFO = { name: "creator-ai", version: "0.1.0" };
const DEFAULT_PROTOCOL = "2025-03-26";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, mcp-session-id, mcp-protocol-version",
};

/* ----------------------------- small helpers ----------------------------- */

const trunc = (s, n = 1500) =>
  typeof s === "string" && s.length > n ? s.slice(0, n) + "…[truncated]" : s;

const stripHtml = (h) =>
  typeof h === "string"
    ? h
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim()
    : h;

const pick = (o, keys) =>
  Object.fromEntries(
    keys.filter((k) => o && o[k] !== undefined && o[k] !== null).map((k) => [k, o[k]])
  );

const enc = (v) => encodeURIComponent(String(v));

function requireArgs(args, names) {
  for (const n of names) {
    if (args[n] === undefined || args[n] === null || args[n] === "") {
      throw new Error(`Missing required argument: ${n}`);
    }
  }
}

function addQuery(url, query) {
  if (!query) return;
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(`${k}[]`, String(x)));
    else url.searchParams.set(k, String(v));
  }
}

/* ------------------------------ Canvas client ----------------------------- */

function canvasBase(env) {
  if (!env.CANVAS_BASE_URL || !env.CANVAS_TOKEN) {
    throw new Error("CANVAS_BASE_URL and CANVAS_TOKEN are not configured on the Worker.");
  }
  return env.CANVAS_BASE_URL.replace(/\/+$/, "");
}

function parseNext(link) {
  if (!link) return null;
  const m = link.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}

async function canvasReq(env, pathOrUrl, { method = "GET", query, body } = {}) {
  const base = canvasBase(env);
  let url;
  if (pathOrUrl.startsWith("http")) {
    if (!pathOrUrl.startsWith(base)) throw new Error("Refusing to follow a foreign pagination URL.");
    url = new URL(pathOrUrl);
  } else {
    url = new URL(`${base}/api/v1${pathOrUrl}`);
  }
  addQuery(url, query);

  const headers = { Authorization: `Bearer ${env.CANVAS_TOKEN}`, Accept: "application/json" };
  const init = { method, headers };
  if (body) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url.toString(), init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Canvas ${res.status} on ${method} ${url.pathname}: ${trunc(text, 300)}`);
  }
  return { data: text ? JSON.parse(text) : null, next: parseNext(res.headers.get("link")) };
}

async function canvasAll(env, path, query, maxPages = 5) {
  const items = [];
  let { data, next } = await canvasReq(env, path, { query: { per_page: 100, ...query } });
  items.push(...(Array.isArray(data) ? data : []));
  let pages = 1;
  while (next && pages < maxPages) {
    ({ data, next } = await canvasReq(env, next));
    items.push(...(Array.isArray(data) ? data : []));
    pages++;
  }
  return { items, truncated: Boolean(next) };
}

/* ------------------------------- slimmers -------------------------------- */

const slimSubmission = (s, full = false) => {
  const o = pick(s, [
    "user_id", "workflow_state", "score", "grade", "submitted_at", "graded_at",
    "late", "missing", "excused", "attempt", "submission_type", "url",
  ]);
  if (s.user?.name) o.name = s.user.name;
  if (s.body) o.body = trunc(stripHtml(s.body), full ? 4000 : 300);
  if (s.attachments?.length) {
    o.attachments = s.attachments.map((a) => ({
      name: a.display_name, type: a["content-type"], url: a.url,
    }));
  }
  if (s.media_comment?.url) o.media = { type: s.media_comment.media_type, url: s.media_comment.url };
  const comments = s.submission_comments || [];
  if (full) {
    o.comments = comments.map((c) => ({
      author: c.author_name, at: c.created_at, text: trunc(c.comment, 1000),
    }));
    if (s.rubric_assessment) o.rubric_assessment = s.rubric_assessment;
  } else if (comments.length) {
    o.comment_count = comments.length;
  }
  return o;
};

/* --------------------------------- tools --------------------------------- */

const idProp = (desc) => ({ type: ["string", "integer"], description: desc });

function guardWrite(env) {
  if (String(env.READ_ONLY).toLowerCase() === "true") {
    throw new Error("Worker is in READ_ONLY mode. Grading and comments are disabled.");
  }
}

async function putSubmission(env, a, body) {
  const { data } = await canvasReq(
    env,
    `/courses/${enc(a.course_id)}/assignments/${enc(a.assignment_id)}/submissions/${enc(a.user_id)}`,
    { method: "PUT", body }
  );
  return slimSubmission(data, true);
}

const TOOLS = [
  {
    name: "list_courses",
    description: "List the courses the token owner is enrolled in or teaches (active by default).",
    inputSchema: {
      type: "object",
      properties: {
        enrollment_state: {
          type: "string", enum: ["active", "invited_or_pending", "completed"],
          description: "Default: active",
        },
      },
    },
    annotations: { readOnlyHint: true },
    run: async (env, a) => {
      const { items } = await canvasAll(env, "/courses", {
        enrollment_state: a.enrollment_state || "active",
      });
      return items.map((c) =>
        pick(c, ["id", "name", "course_code", "workflow_state", "start_at", "end_at"])
      );
    },
  },
  {
    name: "list_assignments",
    description:
      "List assignments in a course, including how many submissions still need grading.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: idProp("Canvas course id"),
        search_term: { type: "string", description: "Filter by name" },
        bucket: {
          type: "string",
          enum: ["past", "overdue", "undated", "ungraded", "unsubmitted", "upcoming", "future"],
          description: "Optional Canvas bucket filter",
        },
      },
      required: ["course_id"],
    },
    annotations: { readOnlyHint: true },
    run: async (env, a) => {
      requireArgs(a, ["course_id"]);
      const { items, truncated } = await canvasAll(env, `/courses/${enc(a.course_id)}/assignments`, {
        search_term: a.search_term,
        bucket: a.bucket,
      });
      return {
        truncated,
        assignments: items.map((x) =>
          pick(x, [
            "id", "name", "due_at", "points_possible", "grading_type",
            "submission_types", "published", "needs_grading_count",
          ])
        ),
      };
    },
  },
  {
    name: "get_assignment",
    description: "Get one assignment with its instructions and rubric.",
    inputSchema: {
      type: "object",
      properties: { course_id: idProp("Canvas course id"), assignment_id: idProp("Assignment id") },
      required: ["course_id", "assignment_id"],
    },
    annotations: { readOnlyHint: true },
    run: async (env, a) => {
      requireArgs(a, ["course_id", "assignment_id"]);
      const { data } = await canvasReq(
        env,
        `/courses/${enc(a.course_id)}/assignments/${enc(a.assignment_id)}`
      );
      const o = pick(data, [
        "id", "name", "due_at", "points_possible", "grading_type",
        "submission_types", "published", "needs_grading_count", "rubric_settings",
      ]);
      if (data.description) o.description = trunc(stripHtml(data.description), 3000);
      if (data.rubric) {
        o.rubric = data.rubric.map((r) => ({
          id: r.id,
          description: r.description,
          long_description: trunc(r.long_description, 400),
          points: r.points,
          ratings: (r.ratings || []).map((x) => ({
            id: x.id, points: x.points, description: x.description,
          })),
        }));
      }
      return o;
    },
  },
  {
    name: "list_submissions",
    description:
      "List all student submissions for an assignment. Use only_needs_grading to see the marking queue.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: idProp("Canvas course id"),
        assignment_id: idProp("Assignment id"),
        only_needs_grading: {
          type: "boolean",
          description: "Only submissions that are submitted/pending review and not yet graded",
        },
        max_pages: { type: "integer", description: "Pages of 100 to fetch (default 5)" },
      },
      required: ["course_id", "assignment_id"],
    },
    annotations: { readOnlyHint: true },
    run: async (env, a) => {
      requireArgs(a, ["course_id", "assignment_id"]);
      const { items, truncated } = await canvasAll(
        env,
        `/courses/${enc(a.course_id)}/assignments/${enc(a.assignment_id)}/submissions`,
        { include: ["user", "submission_comments"] },
        Math.min(Number(a.max_pages) || 5, 20)
      );
      let subs = items;
      if (a.only_needs_grading) {
        subs = subs.filter(
          (s) => s.workflow_state === "pending_review" ||
                 (s.workflow_state === "submitted" && s.score == null)
        );
      }
      return { truncated, count: subs.length, submissions: subs.map((s) => slimSubmission(s)) };
    },
  },
  {
    name: "get_submission",
    description:
      "Get one student's full submission: text, attachments, media, comments and rubric assessment.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: idProp("Canvas course id"),
        assignment_id: idProp("Assignment id"),
        user_id: idProp("Student's Canvas user id"),
      },
      required: ["course_id", "assignment_id", "user_id"],
    },
    annotations: { readOnlyHint: true },
    run: async (env, a) => {
      requireArgs(a, ["course_id", "assignment_id", "user_id"]);
      const { data } = await canvasReq(
        env,
        `/courses/${enc(a.course_id)}/assignments/${enc(a.assignment_id)}/submissions/${enc(a.user_id)}`,
        { query: { include: ["user", "submission_comments", "rubric_assessment"] } }
      );
      return slimSubmission(data, true);
    },
  },
  {
    name: "get_course_grades",
    description: "Course gradebook overview: current and final score for every active student.",
    inputSchema: {
      type: "object",
      properties: { course_id: idProp("Canvas course id") },
      required: ["course_id"],
    },
    annotations: { readOnlyHint: true },
    run: async (env, a) => {
      requireArgs(a, ["course_id"]);
      const { items, truncated } = await canvasAll(
        env,
        `/courses/${enc(a.course_id)}/enrollments`,
        { type: ["StudentEnrollment"], state: ["active"], include: ["grades"] }
      );
      return {
        truncated,
        students: items.map((e) => ({
          user_id: e.user_id,
          name: e.user?.name,
          current_score: e.grades?.current_score ?? null,
          current_grade: e.grades?.current_grade ?? null,
          final_score: e.grades?.final_score ?? null,
          final_grade: e.grades?.final_grade ?? null,
        })),
      };
    },
  },
  {
    name: "get_student_grades",
    description: "One student's overall grade plus a per-assignment score breakdown in a course.",
    inputSchema: {
      type: "object",
      properties: { course_id: idProp("Canvas course id"), user_id: idProp("Student's user id") },
      required: ["course_id", "user_id"],
    },
    annotations: { readOnlyHint: true },
    run: async (env, a) => {
      requireArgs(a, ["course_id", "user_id"]);
      const [enr, subs] = await Promise.all([
        canvasReq(env, `/courses/${enc(a.course_id)}/enrollments`, {
          query: { user_id: a.user_id, type: ["StudentEnrollment"], include: ["grades"] },
        }),
        canvasAll(env, `/courses/${enc(a.course_id)}/students/submissions`, {
          student_ids: [a.user_id],
          include: ["assignment"],
        }),
      ]);
      const e = Array.isArray(enr.data) ? enr.data[0] : null;
      return {
        overall: e
          ? pick(e.grades || {}, ["current_score", "current_grade", "final_score", "final_grade"])
          : null,
        assignments: subs.items.map((s) => ({
          assignment_id: s.assignment_id,
          name: s.assignment?.name,
          points_possible: s.assignment?.points_possible,
          score: s.score,
          grade: s.grade,
          workflow_state: s.workflow_state,
          late: s.late,
          missing: s.missing,
          excused: s.excused,
        })),
      };
    },
  },
  {
    name: "grade_submission",
    description:
      "WRITES TO CANVAS. Set a grade on a submission (points, percent like '85%', letter, or pass/fail), " +
      "optionally with a comment, an excuse, or per-criterion rubric points.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: idProp("Canvas course id"),
        assignment_id: idProp("Assignment id"),
        user_id: idProp("Student's Canvas user id"),
        grade: { type: ["string", "number"], description: "e.g. 85, '85%', 'A', 'complete'" },
        comment: { type: "string", description: "Optional feedback shown to the student" },
        excused: { type: "boolean", description: "Excuse the student instead of grading" },
        rubric_assessment: {
          type: "object",
          description:
            "Optional. Map of criterion_id -> { points: number, comments?: string, rating_id?: string }",
        },
      },
      required: ["course_id", "assignment_id", "user_id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    run: async (env, a) => {
      guardWrite(env);
      requireArgs(a, ["course_id", "assignment_id", "user_id"]);
      if (a.grade === undefined && !a.excused && !a.rubric_assessment) {
        throw new Error("Provide grade, excused, or rubric_assessment.");
      }
      const body = {};
      const submission = {};
      if (a.grade !== undefined) submission.posted_grade = String(a.grade);
      if (a.excused) submission.excuse = true;
      if (Object.keys(submission).length) body.submission = submission;
      if (a.comment) body.comment = { text_comment: a.comment };
      if (a.rubric_assessment) body.rubric_assessment = a.rubric_assessment;
      return await putSubmission(env, a, body);
    },
  },
  {
    name: "add_submission_comment",
    description: "WRITES TO CANVAS. Leave feedback on a submission without changing the grade.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: idProp("Canvas course id"),
        assignment_id: idProp("Assignment id"),
        user_id: idProp("Student's Canvas user id"),
        comment: { type: "string", description: "Feedback text" },
      },
      required: ["course_id", "assignment_id", "user_id", "comment"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: async (env, a) => {
      guardWrite(env);
      requireArgs(a, ["course_id", "assignment_id", "user_id", "comment"]);
      return await putSubmission(env, a, { comment: { text_comment: a.comment } });
    },
  },
];

/* ------------------------------- MCP layer ------------------------------- */

const INSTRUCTIONS =
  "Creator AI: Canvas LMS grading tools. Find ids with list_courses -> list_assignments -> list_submissions. " +
  "Read a submission fully before grading it. grade_submission and add_submission_comment write to Canvas; " +
  "confirm with the teacher before writing unless they already told you to.";

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleRpc(msg, env) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, {
        tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({
          name, description, inputSchema, annotations,
        })),
      });

    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        const result = await tool.run(env, params.arguments || {});
        return ok(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
        });
      } catch (err) {
        return ok(id, {
          isError: true,
          content: [{ type: "text", text: String(err?.message || err) }],
        });
      }
    }

    default:
      if (isNotification) return null; // e.g. notifications/initialized
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

function authorized(request, env, url) {
  if (!env.MCP_KEY) return false; // refuse to run wide open
  const header = request.headers.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  const key = bearer || url.searchParams.get("key") || "";
  return key.length > 0 && key === env.MCP_KEY;
}

const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse({ ...SERVER_INFO, status: "alive", mcp: "/mcp" });
    }

    if (url.pathname !== "/mcp") return jsonResponse({ error: "Not found" }, 404);

    if (!authorized(request, env, url)) {
      return jsonResponse(
        { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } },
        401
      );
    }

    // Streamable HTTP: we don't offer a server-initiated SSE stream.
    if (request.method === "GET") return new Response("Use POST", { status: 405, headers: CORS });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

    let payload;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse(fail(null, -32700, "Parse error"), 400);
    }

    if (Array.isArray(payload)) {
      const results = (await Promise.all(payload.map((m) => handleRpc(m, env)))).filter(Boolean);
      return results.length
        ? jsonResponse(results)
        : new Response(null, { status: 202, headers: CORS });
    }

    const result = await handleRpc(payload, env);
    return result ? jsonResponse(result) : new Response(null, { status: 202, headers: CORS });
  },
};
