"use client";

// Pick several people by tapping their names (chat rooms, task assignors).

export function PeoplePicker({
  people,
  value,
  onChange,
}: {
  people: { id: string; name: string }[];
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {people.map((p) => {
        const on = value.includes(p.id);
        return (
          <button
            key={p.id}
            type="button"
            onClick={() => onChange(on ? value.filter((x) => x !== p.id) : [...value, p.id])}
            className={`px-2 py-1 rounded text-xs border ${on ? "bg-blue-600 border-blue-500 text-white" : "bg-slate-800 border-slate-600 text-slate-300"}`}
            aria-pressed={on}
          >
            {p.name}
          </button>
        );
      })}
    </div>
  );
}
