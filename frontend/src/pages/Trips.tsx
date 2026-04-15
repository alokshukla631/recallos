import { useState, useEffect, useCallback } from "react";
import "./Trips.css";

type TripStatus = "planning" | "active" | "completed" | "cancelled";

interface Trip {
  id: string;
  name: string;
  destination: string | null;
  start_date: string | null;
  end_date: string | null;
  status: TripStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
  conversation_count?: number;
  memory_count?: number;
}

const EMPTY_FORM = {
  name: "",
  destination: "",
  start_date: "",
  end_date: "",
  status: "planning" as TripStatus,
  notes: "",
};

function Trips() {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  const fetchTrips = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/trips");
      if (!res.ok) throw new Error("Failed to load trips");
      const data: Trip[] = await res.json();
      setTrips(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load trips");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTrips();
  }, [fetchTrips]);

  function openNewForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
    setError(null);
  }

  function openEditForm(trip: Trip) {
    setEditingId(trip.id);
    setForm({
      name: trip.name,
      destination: trip.destination ?? "",
      start_date: trip.start_date ?? "",
      end_date: trip.end_date ?? "",
      status: trip.status,
      notes: trip.notes ?? "",
    });
    setShowForm(true);
    setError(null);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
  }

  async function saveTrip(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }

    const body = {
      name: form.name.trim(),
      destination: form.destination.trim() || null,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      status: form.status,
      notes: form.notes.trim() || null,
    };

    try {
      const url = editingId ? `/api/trips/${editingId}` : "/api/trips";
      const method = editingId ? "PATCH" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to save trip");
      }
      await fetchTrips();
      closeForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save trip");
    }
  }

  async function removeTrip(id: string) {
    if (!confirm("Delete this trip? Conversations and memories linked to it will be kept but unlinked.")) return;
    try {
      const res = await fetch(`/api/trips/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete trip");
      fetchTrips();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete trip");
    }
  }

  function formatDate(date: string | null) {
    if (!date) return "—";
    try {
      // Parse as local date to avoid UTC midnight rolling back a day
      // in negative-UTC-offset timezones (e.g. "2026-07-10" parsed as
      // UTC midnight becomes July 9 in UTC-5).
      const [y, m, d] = date.split("-").map(Number);
      return new Date(y, m - 1, d).toLocaleDateString();
    } catch {
      return date;
    }
  }

  if (loading) {
    return (
      <div className="trips-page">
        <div className="trips-header">
          <h2>Trips</h2>
        </div>
        <div className="trips-empty">Loading...</div>
      </div>
    );
  }

  return (
    <div className="trips-page">
      <div className="trips-header">
        <h2>Trips</h2>
        <button className="trips-new-btn" onClick={openNewForm}>
          + New Trip
        </button>
      </div>

      {error && <div className="trips-error">{error}</div>}

      {showForm && (
        <form className="trip-form" onSubmit={saveTrip}>
          <h3>{editingId ? "Edit Trip" : "New Trip"}</h3>
          <div className="form-row">
            <label>
              Name *
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Summer Japan trip"
                required
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              Destination
              <input
                type="text"
                value={form.destination}
                onChange={(e) => setForm({ ...form, destination: e.target.value })}
                placeholder="Tokyo, Japan"
              />
            </label>
          </div>
          <div className="form-row two-col">
            <label>
              Start date
              <input
                type="date"
                value={form.start_date}
                onChange={(e) => setForm({ ...form, start_date: e.target.value })}
              />
            </label>
            <label>
              End date
              <input
                type="date"
                value={form.end_date}
                onChange={(e) => setForm({ ...form, end_date: e.target.value })}
              />
            </label>
          </div>
          <div className="form-row">
            <label>
              Status
              <select
                value={form.status}
                onChange={(e) => setForm({ ...form, status: e.target.value as TripStatus })}
              >
                <option value="planning">Planning</option>
                <option value="active">Active</option>
                <option value="completed">Completed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              Notes
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Any notes about this trip..."
                rows={3}
              />
            </label>
          </div>
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={closeForm}>
              Cancel
            </button>
            <button type="submit" className="btn-primary">
              {editingId ? "Save Changes" : "Create Trip"}
            </button>
          </div>
        </form>
      )}

      {trips.length === 0 ? (
        <div className="trips-empty">
          No trips yet. Create one to scope memories and conversations to a specific trip.
        </div>
      ) : (
        <div className="trips-grid">
          {trips.map((trip) => (
            <div key={trip.id} className={`trip-card status-${trip.status}`}>
              <div className="trip-card-header">
                <h3>{trip.name}</h3>
                <span className={`status-badge status-${trip.status}`}>{trip.status}</span>
              </div>
              {trip.destination && <div className="trip-destination">{trip.destination}</div>}
              <div className="trip-dates">
                {formatDate(trip.start_date)} → {formatDate(trip.end_date)}
              </div>
              {trip.notes && <div className="trip-notes">{trip.notes}</div>}
              <div className="trip-stats">
                <span>{trip.conversation_count ?? 0} conversations</span>
                <span>{trip.memory_count ?? 0} memories</span>
              </div>
              <div className="trip-actions">
                <button className="btn-link" onClick={() => openEditForm(trip)}>
                  Edit
                </button>
                <button className="btn-link danger" onClick={() => removeTrip(trip.id)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default Trips;
