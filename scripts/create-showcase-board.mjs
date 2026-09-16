// Synthetic viewing example only. No circuit, routing or fabrication validation.
// Run from the repository root; reads no private board or project files.
import { mkdir, writeFile } from "node:fs/promises";
const items = [], add = s => items.push(s);
const line = (x1,y1,x2,y2,side="F.Cu") => add(`(segment (start ${x1} ${y1}) (end ${x2} ${y2}) (width 0.45) (layer "${side}"))`);
const passive = (ref,x,y,value) => add(`(footprint "Synthetic:Passive" (layer "F.Cu") (at ${x} ${y}) (property "Reference" "${ref}") (property "Value" "${value}") (fp_rect (start -1.5 -0.8) (end 1.5 0.8) (stroke (width 0.15)) (layer "F.Fab")) (pad "1" smd roundrect (at -2.3 0) (size 1.6 2) (layers "F.Cu") (roundrect_rratio 0.2)) (pad "2" smd roundrect (at 2.3 0) (size 1.6 2) (layers "F.Cu") (roundrect_rratio 0.2)))`);
for(const [i,x] of [16,26,38,48].entries()) { passive(`R${i+1}`,x,10,"10k"); passive(`C${i+1}`,x,34,"100n"); }
for(const [ref,x] of [["J1",7],["J2",57]]) add(`(footprint "Synthetic:Header_1x03" (layer "F.Cu") (at ${x} 22) (property "Reference" "${ref}") (property "Value" "I/O") (fp_rect (start -2 -7) (end 2 7) (stroke (width 0.18)) (layer "F.Fab")) ${[-5,0,5].map((y,i)=>`(pad "${i+1}" thru_hole circle (at 0 ${y}) (size 2.8 2.8) (drill 1) (layers "*.Cu"))`).join(' ')})`);
for(const [ref,x] of [["U1",23],["U2",41]]) add(`(footprint "Synthetic:Controller" (layer "F.Cu") (at ${x} 22) (property "Reference" "${ref}") (property "Value" "Demo controller") (fp_rect (start -5 -3) (end 5 3) (stroke (width 0.18)) (layer "F.Fab")) ${[-4,-2,0,2,4].flatMap((px,i)=>[-1,1].map((side,j)=>`(pad "${i+1+j*5}" smd rect (at ${px} ${side*4}) (size 1.1 2) (layers "F.Cu"))`)).join(' ')})`);
for(const x of [5,59]) for(const y of [5,39]) add(`(footprint "Synthetic:Mount" (layer "F.Cu") (at ${x} ${y}) (property "Reference" "H${x}-${y}") (pad "" np_thru_hole circle (at 0 0) (size 3 3) (drill 3) (layers "*.Cu")))`);
for(const [i,x] of [16,26,38,48].entries()) { const target=i<2?19+i*6:37+(i-2)*6; line(x+2.3,10,target,14); line(target,14,target,18); line(target,26,target,30); line(target,30,x-2.3,34); }
line(7,17,13,17); line(13,17,19,18); line(7,22,13,22); line(13,22,13,30); line(13,30,23,30); line(23,30,23,26);
line(57,17,51,17); line(51,17,45,18); line(57,22,51,22); line(51,22,51,30); line(51,30,41,30); line(41,30,41,26);
line(7,27,11,31,"B.Cu"); line(11,31,53,31,"B.Cu"); line(53,31,57,27,"B.Cu");
const board=`(kicad_pcb (version 20240108) (generator "benchledger_synthetic_showcase")\n(general (thickness 1.6))\n(layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))\n(gr_rect (start 0 0) (end 64 44) (layer "Edge.Cuts"))\n${items.join('\n')}\n)\n`;
await mkdir("docs/assets/showcase",{recursive:true});
await writeFile("docs/assets/showcase/synthetic-controller.kicad_pcb",board);
console.log("Wrote a synthetic 64 × 44 mm board for viewing only. Not a validated circuit.");
