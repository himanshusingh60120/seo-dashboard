"use client";
import {
  ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis, Tooltip, CartesianGrid, Legend, LineChart,
} from "recharts";
import { compact } from "./ui";

const axis = { fontSize: 12, fill: "#7b8794" };
const tick = (d: string) => d.slice(5);

export function SearchTrend({ data }: { data: { date: string; clicks: number; impressions: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="#e7ebef" vertical={false} />
        <XAxis dataKey="date" tick={axis} tickFormatter={tick} minTickGap={24} />
        <YAxis yAxisId="i" tick={axis} tickFormatter={compact} width={48} />
        <YAxis yAxisId="c" orientation="right" tick={axis} tickFormatter={compact} width={40} />
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 13 }} />
        <Area yAxisId="i" dataKey="impressions" name="Impressions" fill="#d2dae8" stroke="#9bb0d9" />
        <Line yAxisId="c" dataKey="clicks" name="Clicks" stroke="#2e4c8c" strokeWidth={2} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function PositionTrend({ data }: { data: { date: string; position: number; ctr: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data.map((d) => ({ ...d, ctrPct: +(d.ctr * 100).toFixed(2), position: +d.position.toFixed(1) }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="#e7ebef" vertical={false} />
        <XAxis dataKey="date" tick={axis} tickFormatter={tick} minTickGap={24} />
        <YAxis yAxisId="p" reversed tick={axis} width={40} domain={["dataMin - 1", "dataMax + 1"]} />
        <YAxis yAxisId="c" orientation="right" tick={axis} width={40} unit="%" />
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 13 }} />
        <Line yAxisId="p" dataKey="position" name="Avg. position" stroke="#17202b" dot={false} strokeWidth={2} />
        <Line yAxisId="c" dataKey="ctrPct" name="CTR %" stroke="#16794a" dot={false} strokeWidth={2} />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function TrafficTrend({ data }: { data: { date: string; users: number; sessions: number; organicSessions: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke="#e7ebef" vertical={false} />
        <XAxis dataKey="date" tick={axis} tickFormatter={tick} minTickGap={24} />
        <YAxis tick={axis} tickFormatter={compact} width={48} />
        <Tooltip />
        <Legend wrapperStyle={{ fontSize: 13 }} />
        <Area dataKey="sessions" name="Sessions" fill="#d2dae8" stroke="#9bb0d9" />
        <Line dataKey="users" name="Users" stroke="#2e4c8c" strokeWidth={2} dot={false} />
        <Line dataKey="organicSessions" name="Organic search sessions" stroke="#16794a" strokeWidth={2} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}
