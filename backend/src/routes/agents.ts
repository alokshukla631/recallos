/**
 * Agent state API: plans, steps, and checkpoints.
 *
 * Lets agents store multi-step plans, track progress per step,
 * record failures, and checkpoint arbitrary state so they can resume
 * after interruption.
 */
import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { queryAll, queryOne, runSql } from "../db/index.js";

const router = Router();

// ── Plans ───────────────────────────────────────────────────────────────────

// GET /plans - list plans
router.get("/plans", (req: Request, res: Response) => {
  try {
    const status = req.query.status as string | undefined;
    let sql = "SELECT * FROM agent_plans";
    const params: unknown[] = [];
    if (status && status !== "all") {
      sql += " WHERE status = ?";
      params.push(status);
    }
    sql += " ORDER BY updated_at DESC";
    res.json(queryAll(sql, params));
  } catch (err) {
    console.error("GET /api/agents/plans error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /plans - create a plan with steps
router.post("/plans", (req: Request, res: Response) => {
  try {
    const { name, description, steps, metadata } = req.body;
    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const planId = uuidv4();
    runSql(
      `INSERT INTO agent_plans (id, name, description, metadata_json) VALUES (?, ?, ?, ?)`,
      [planId, name, description ?? null, JSON.stringify(metadata ?? {})]
    );

    // Create steps if provided
    if (Array.isArray(steps)) {
      for (let i = 0; i < steps.length; i++) {
        const stepId = uuidv4();
        const desc = typeof steps[i] === "string" ? steps[i] : steps[i]?.description ?? `Step ${i + 1}`;
        runSql(
          `INSERT INTO agent_steps (id, plan_id, step_index, description) VALUES (?, ?, ?, ?)`,
          [stepId, planId, i, desc]
        );
      }
    }

    const plan = queryOne("SELECT * FROM agent_plans WHERE id = ?", [planId]);
    const planSteps = queryAll(
      "SELECT * FROM agent_steps WHERE plan_id = ? ORDER BY step_index",
      [planId]
    );
    res.status(201).json({ ...plan, steps: planSteps });
  } catch (err) {
    console.error("POST /api/agents/plans error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /plans/:id - get a plan with its steps
router.get("/plans/:id", (req: Request, res: Response) => {
  try {
    const plan = queryOne("SELECT * FROM agent_plans WHERE id = ?", [req.params.id]);
    if (!plan) {
      res.status(404).json({ error: "Plan not found" });
      return;
    }
    const steps = queryAll(
      "SELECT * FROM agent_steps WHERE plan_id = ? ORDER BY step_index",
      [req.params.id]
    );
    res.json({ ...plan, steps });
  } catch (err) {
    console.error("GET /api/agents/plans/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /plans/:id - update plan status
router.patch("/plans/:id", (req: Request, res: Response) => {
  try {
    const { status, description } = req.body;
    const fields: string[] = [];
    const params: unknown[] = [];

    if (status) { fields.push("status = ?"); params.push(status); }
    if (description !== undefined) { fields.push("description = ?"); params.push(description); }
    if (fields.length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    fields.push("updated_at = datetime('now')");
    params.push(req.params.id);
    runSql(`UPDATE agent_plans SET ${fields.join(", ")} WHERE id = ?`, params);
    res.json(queryOne("SELECT * FROM agent_plans WHERE id = ?", [req.params.id]));
  } catch (err) {
    console.error("PATCH /api/agents/plans/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Steps ───────────────────────────────────────────────────────────────────

// PATCH /steps/:id - update a step (status, result, error)
router.patch("/steps/:id", (req: Request, res: Response) => {
  try {
    const { status, result, error: stepError } = req.body;
    const fields: string[] = [];
    const params: unknown[] = [];

    if (status) { fields.push("status = ?"); params.push(status); }
    if (result !== undefined) { fields.push("result = ?"); params.push(result); }
    if (stepError !== undefined) { fields.push("error = ?"); params.push(stepError); }
    if (fields.length === 0) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }
    fields.push("updated_at = datetime('now')");
    params.push(req.params.id);
    runSql(`UPDATE agent_steps SET ${fields.join(", ")} WHERE id = ?`, params);

    const step = queryOne("SELECT * FROM agent_steps WHERE id = ?", [req.params.id]);
    if (!step) {
      res.status(404).json({ error: "Step not found" });
      return;
    }

    // Auto-complete or auto-fail the plan if all steps are done
    if (step.plan_id) {
      const allSteps = queryAll(
        "SELECT status FROM agent_steps WHERE plan_id = ?",
        [step.plan_id]
      );
      const allDone = allSteps.every(
        (s) => s.status === "completed" || s.status === "failed" || s.status === "skipped"
      );
      if (allDone) {
        const anyFailed = allSteps.some((s) => s.status === "failed");
        const newPlanStatus = anyFailed ? "failed" : "completed";
        runSql(
          "UPDATE agent_plans SET status = ?, updated_at = datetime('now') WHERE id = ?",
          [newPlanStatus, step.plan_id]
        );
      }
    }

    res.json(step);
  } catch (err) {
    console.error("PATCH /api/agents/steps/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ── Checkpoints ─────────────────────────────────────────────────────────────

// POST /checkpoints - save a checkpoint
router.post("/checkpoints", (req: Request, res: Response) => {
  try {
    const { plan_id, label, state } = req.body;
    if (!label || !state) {
      res.status(400).json({ error: "label and state are required" });
      return;
    }
    const id = uuidv4();
    runSql(
      `INSERT INTO agent_checkpoints (id, plan_id, label, state_json) VALUES (?, ?, ?, ?)`,
      [id, plan_id ?? null, label, JSON.stringify(state)]
    );
    res.status(201).json(queryOne("SELECT * FROM agent_checkpoints WHERE id = ?", [id]));
  } catch (err) {
    console.error("POST /api/agents/checkpoints error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /checkpoints - list checkpoints (optionally filtered by plan_id)
router.get("/checkpoints", (req: Request, res: Response) => {
  try {
    const planId = req.query.plan_id as string | undefined;
    let sql = "SELECT * FROM agent_checkpoints";
    const params: unknown[] = [];
    if (planId) {
      sql += " WHERE plan_id = ?";
      params.push(planId);
    }
    sql += " ORDER BY created_at DESC LIMIT 50";
    const rows = queryAll(sql, params);
    // Parse state_json for the response
    const parsed = rows.map((r) => ({
      ...r,
      state: JSON.parse(r.state_json as string || "{}"),
    }));
    res.json(parsed);
  } catch (err) {
    console.error("GET /api/agents/checkpoints error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /checkpoints/latest - get the most recent checkpoint (optionally by plan_id)
router.get("/checkpoints/latest", (req: Request, res: Response) => {
  try {
    const planId = req.query.plan_id as string | undefined;
    let sql = "SELECT * FROM agent_checkpoints";
    const params: unknown[] = [];
    if (planId) {
      sql += " WHERE plan_id = ?";
      params.push(planId);
    }
    sql += " ORDER BY created_at DESC LIMIT 1";
    const row = queryAll(sql, params)[0];
    if (!row) {
      res.status(404).json({ error: "No checkpoint found" });
      return;
    }
    res.json({ ...row, state: JSON.parse(row.state_json as string || "{}") });
  } catch (err) {
    console.error("GET /api/agents/checkpoints/latest error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
