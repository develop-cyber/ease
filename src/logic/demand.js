export const CAPACITY = 100; // vehicles per 5-min window (mock)
export function align5(date){ const d=new Date(date); d.setSeconds(0,0); d.setMinutes(Math.floor(d.getMinutes()/5)*5); return d; }
function demandAt(dt){ const t=dt.getHours()*60+dt.getMinutes(), peak=8*60+30, sigma=60, base=25, amp=90;
  const gauss = amp * Math.exp(-0.5 * ((t-peak)/sigma)**2); return base+gauss; }
export function headroom(dt){ return (CAPACITY - demandAt(dt))/CAPACITY; }
export function reliability(dt){ const ratio=demandAt(dt)/CAPACITY; const r=1-Math.max(0, ratio-0.7); return Math.max(0, Math.min(1, r)); }
