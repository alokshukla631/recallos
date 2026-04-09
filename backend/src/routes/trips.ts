import { Router, Request, Response } from "express";
import {
  listTrips,
  getTrip,
  createTrip,
  updateTrip,
  deleteTrip,
  type TripStatus,
} from "../modules/trips.js";

const router = Router();

const VALID_STATUSES: TripStatus[] = ["planning", "active", "completed", "cancelled"];

function isValidStatus(value: unknown): value is TripStatus {
  return typeof value === "string" && VALID_STATUSES.includes(value as TripStatus);
}

// GET / - list all trips
router.get("/", (_req: Request, res: Response) => {
  try {
    res.json(listTrips());
  } catch (err) {
    console.error("GET /api/trips error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /:id - get a single trip
router.get("/:id", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const trip = getTrip(id);
    if (!trip) {
      res.status(404).json({ error: "Trip not found" });
      return;
    }
    res.json(trip);
  } catch (err) {
    console.error("GET /api/trips/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST / - create a new trip
router.post("/", (req: Request, res: Response) => {
  try {
    const { name, destination, start_date, end_date, status, notes } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    if (status !== undefined && !isValidStatus(status)) {
      res.status(400).json({
        error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
      });
      return;
    }

    const trip = createTrip({
      name: name.trim(),
      destination: destination ?? null,
      start_date: start_date ?? null,
      end_date: end_date ?? null,
      status: status ?? "planning",
      notes: notes ?? null,
    });

    res.status(201).json(trip);
  } catch (err) {
    console.error("POST /api/trips error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /:id - update a trip
router.patch("/:id", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const existing = getTrip(id);
    if (!existing) {
      res.status(404).json({ error: "Trip not found" });
      return;
    }

    const { name, destination, start_date, end_date, status, notes } = req.body;

    if (status !== undefined && !isValidStatus(status)) {
      res.status(400).json({
        error: `status must be one of: ${VALID_STATUSES.join(", ")}`,
      });
      return;
    }

    if (name !== undefined && (typeof name !== "string" || !name.trim())) {
      res.status(400).json({ error: "name cannot be empty" });
      return;
    }

    const updated = updateTrip(id, {
      name: name?.trim(),
      destination,
      start_date,
      end_date,
      status,
      notes,
    });

    res.json(updated);
  } catch (err) {
    console.error("PATCH /api/trips/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /:id - delete a trip (orphans conversations and memories)
router.delete("/:id", (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const trip = getTrip(id);
    if (!trip) {
      res.status(404).json({ error: "Trip not found" });
      return;
    }
    deleteTrip(id);
    res.json({ message: "Trip deleted" });
  } catch (err) {
    console.error("DELETE /api/trips/:id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
