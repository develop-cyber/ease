// src/lib/time.js
// Keep date/time as a LOCAL "YYYY-MM-DDTHH:mm" string for <input type="datetime-local">
// and convert to/from Date without timezone shifts.

export const toLocalInput = (date) => {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
       + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const fromLocalInput = (localStr) => {
  // localStr like "YYYY-MM-DDTHH:mm"
  const [d, t = "00:00"] = localStr.split("T");
  const [y, m, day] = d.split("-").map(Number);
  const [hh, mm] = t.split(":").map(Number);
  return new Date(y, m - 1, day, hh || 0, mm || 0, 0, 0); // Local time
};
