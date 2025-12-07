import { align5, headroom, reliability } from "./demand";
const THETA = 0.10, R_OK = 0.85;
const idOf = (dt)=>`w_${String(dt.getHours()).padStart(2,"0")}_${String(dt.getMinutes()).padStart(2,"0")}`;
const laneFor = (miles, exitDist=8)=> miles>30 ? "LEFT_LONG" : (exitDist<5 ? "RIGHT_EDGE" : "MIDDLE");

export function buildOffers({ desiredArrival, flex, tripMiles }) {
  const base = align5(new Date(desiredArrival));
  const make = (dt)=>({ id:idOf(dt),
    windowStart: dt.toISOString(), windowEnd: new Date(dt.getTime()+5*60000).toISOString(),
    reliability: reliability(dt), headroom: headroom(dt),
    shift:{ direction: dt<base?"EARLY":dt>base?"LATE":"ONTIME", minutes: Math.round((dt-base)/60000) },
    laneFamily: laneFor(tripMiles), incentives:{ credits: Math.max(0, Math.round(headroom(dt)*4)) } });

  const parent = make(base);
  if (!flex?.on) return { parent, earlier:[], later:[] };

  const collect=(from,to)=>{ const out=[];
    for(let m=from;m<=to;m+=5){ const dt=new Date(base.getTime()+m*60000);
      if (headroom(dt)>=THETA || reliability(dt)>=R_OK) out.push(dt); }
    return out.sort((a,b)=>Math.abs(a-base)-Math.abs(b-base)).slice(0,2).map(make);
  };

  return { parent, earlier: collect(-flex.maxShift, -flex.minShift), later: collect(flex.minShift, flex.maxShift) };
}
