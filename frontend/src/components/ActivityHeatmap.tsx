import { useState, useEffect } from "react";
import "./ActivityHeatmap.css";

interface HeatmapDay {
  date: string;
  total: number;
}

interface Props {
  weeks?: number;
}

function ActivityHeatmap({ weeks = 12 }: Props) {
  const [days, setDays] = useState<HeatmapDay[]>([]);
  const [hoveredDay, setHoveredDay] = useState<HeatmapDay | null>(null);

  useEffect(() => {
    fetch(`/api/memory/audit/heatmap?weeks=${weeks}`)
      .then((res) => (res.ok ? res.json() : { days: [] }))
      .then((data) => setDays(data.days || []))
      .catch(() => setDays([]));
  }, [weeks]);

  if (days.length === 0) return null;

  const maxCount = Math.max(1, ...days.map((d) => d.total));

  function getLevel(count: number): number {
    if (count === 0) return 0;
    const ratio = count / maxCount;
    if (ratio <= 0.25) return 1;
    if (ratio <= 0.5) return 2;
    if (ratio <= 0.75) return 3;
    return 4;
  }

  // Organize days into a grid: columns = weeks, rows = day of week (0-6)
  const grid: (HeatmapDay | null)[][] = [];
  let col: (HeatmapDay | null)[] = [];

  for (let i = 0; i < days.length; i++) {
    const dayOfWeek = new Date(days[i].date + "T12:00:00").getDay();
    // Start a new column on Sunday
    if (dayOfWeek === 0 && col.length > 0) {
      // Pad previous column to 7
      while (col.length < 7) col.push(null);
      grid.push(col);
      col = [];
    }
    // Pad start of first column
    if (grid.length === 0 && col.length === 0 && dayOfWeek > 0) {
      for (let j = 0; j < dayOfWeek; j++) col.push(null);
    }
    col.push(days[i]);
  }
  if (col.length > 0) {
    while (col.length < 7) col.push(null);
    grid.push(col);
  }

  const dayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const totalActivity = days.reduce((sum, d) => sum + d.total, 0);

  return (
    <div className="heatmap-container">
      <div className="heatmap-header">
        <span className="heatmap-total">{totalActivity} memory operations in the last {weeks} weeks</span>
      </div>
      <div className="heatmap-grid-wrapper">
        <div className="heatmap-day-labels">
          {dayLabels.map((label, i) => (
            <span key={i} className="heatmap-day-label">
              {i % 2 === 1 ? label : ""}
            </span>
          ))}
        </div>
        <div className="heatmap-grid">
          {grid.map((week, wi) => (
            <div key={wi} className="heatmap-week">
              {week.map((day, di) => (
                <div
                  key={di}
                  className={`heatmap-cell level-${day ? getLevel(day.total) : "empty"}`}
                  onMouseEnter={() => day && setHoveredDay(day)}
                  onMouseLeave={() => setHoveredDay(null)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
      {hoveredDay && (
        <div className="heatmap-tooltip">
          <strong>{hoveredDay.total} operation{hoveredDay.total !== 1 ? "s" : ""}</strong> on {hoveredDay.date}
        </div>
      )}
      <div className="heatmap-legend">
        <span className="heatmap-legend-label">Less</span>
        <div className="heatmap-cell level-0" />
        <div className="heatmap-cell level-1" />
        <div className="heatmap-cell level-2" />
        <div className="heatmap-cell level-3" />
        <div className="heatmap-cell level-4" />
        <span className="heatmap-legend-label">More</span>
      </div>
    </div>
  );
}

export default ActivityHeatmap;
