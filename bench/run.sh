#!/bin/bash
# usage: bench/run.sh <model> [cases...]
m=$1; shift
cases=${@:-name_plain multi offtopic injection no_pref call_offer_refuse give_number skip_ahead}
for c in $cases; do
  curl -s -m 90 "localhost:8799/?model=$m&case=$c" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);for(const[k,v] of Object.entries(j))console.log(k.padEnd(18),String(v.ms).padStart(5)+"ms",v.fallback?"FALLBACK":"",JSON.stringify({u:Object.fromEntries(Object.entries(v.updates).filter(([a,b])=>b)),d:Object.keys(v.declined).filter(x=>v.declined[x]),a:v.action}),"\n   ",v.replies.join(" | "))}catch(e){console.log("ERR",s.slice(0,200))}})'
done
