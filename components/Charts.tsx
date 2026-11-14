// components/Charts.tsx
"use client";
// Daily charts for the normal view. Google's ranking updates (core, spam…) are shaded when `events` is passed.
import {
  ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis, Tooltip, CartesianGrid, Legend, LineChart, ReferenceArea,
} from "recharts";
import { compact } from "./ui";
import { UPDATE_COLOR, shortUpdateName, todayStr, type GoogleUpdate } from "./googleUpdates";

const axis = { fontSize: 12, fill: "#7b8794" };
const tick = (d: string) => d.slice(5);

/** Shaded bands for the Google updates that fall inside the chart's dates (x axis = YYYY-MM-DD). */
function updateBands(data: { date: string }[], events: GoogleUpdate[] | undefined, yAxisId?: string) {
  if (!events?.length || !data.length) return null;
  const first = data[0].date;
  const last = data[data.length - 1].date;
  const today = todayStr();
  return events.flatMap((u) => {
    const end = u.end || today;
    if (u.start > last || end < first) return [];
    const inside = data.filter((d) => d.date >= u.start && d.date <= end);
    if (!inside.length) return [];
    return [
      <ReferenceArea
        key={u.id}
        {...(yAxisId ? { yAxisId } : {})}
        x1={inside[0].date}
        x2={inside[inside.length - 1].date}
        fill={UPDATE_COLOR[u.kind]}
        fillOpacity={0.1}
        stroke="none"
        ifOverflow="visible"
        label={{ value: shortUpdateName(u), position: "insideTopLeft", fontSize: 10, fill: UPDATE_COLOR[u.kind] }}
      />,
    ];
  });
}

export function SearchTrend({ data, events }: { data: { date: string; clicks: number; impressions: number }[]; events?: GoogleUpdate[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="#e7ebef" vertical={false} />
        <XAxis dataKey="date" tick={axis} tickFormatter={tick} minTickGap={24} />
        <YAxis yAxisId="i" tick={axis} tickFormatter={compact} width={48} />
        <YAxis yAxisId="c" orientation="right" tick={axis} tickFormatter={compact} width={40} />
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 13 }} />
        {updateBands(data, events, "i")}
        <Area yAxisId="i" dataKey="impressions" name="Impressions" fill="#d2dae8" stroke="#9bb0d9" />
        <Line yAxisId="c" dataKey="clicks" name="Clicks" stroke="#2e4c8c" strokeWidth={2} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function PositionTrend({ data, events }: { data: { date: string; position: number; ctr: number }[]; events?: GoogleUpdate[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data.map((d) => ({ ...d, ctrPct: +(d.ctr * 100).toFixed(2), position: +d.position.toFixed(1) }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="#e7ebef" vertical={false} />
        <XAxis dataKey="date" tick={axis} tickFormatter={tick} minTickGap={24} />
        <YAxis yAxisId="p" reversed tick={axis} width={40} domain={["dataMin - 1", "dataMax + 1"]} />
        <YAxis yAxisId="c" orientation="right" tick={axis} width={40} unit="%" />
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 13 }} />
        {updateBands(data, events, "p")}
        <Line yAxisId="p" dataKey="position" name="Avg. position" stroke="#17202b" dot={false} strokeWidth={2} />
        <Line yAxisId="c" dataKey="ctrPct" name="CTR %" stroke="#16794a" dot={false} strokeWidth={2} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function TrafficTrend({
  data, events,
}: { data: { date: string; users: number; sessions: number; organicSessions: number }[]; events?: GoogleUpdate[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="#e7ebef" vertical={false} />
        <XAxis dataKey="date" tick={axis} tickFormatter={tick} minTickGap={24} />
        <YAxis tick={axis} tickFormatter={compact} width={48} />
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 13 }} />
        {updateBands(data, events)}
        <Area dataKey="sessions" name="Sessions" fill="#d2dae8" stroke="#9bb0d9" />
        <Line dataKey="users" name="Users" stroke="#2e4c8c" strokeWidth={2} dot={false} />
        <Line dataKey="organicSessions" name="Organic search sessions" stroke="#16794a" strokeWidth={2} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
