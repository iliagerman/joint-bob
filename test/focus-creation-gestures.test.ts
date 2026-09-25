import assert from "node:assert/strict";
import test from "node:test";
import { recognizeCreationStroke } from "../public/app/focus-creation-gestures.js";

type Point = { x: number; y: number };
const referenceN: Point[] = [
  [250, 1420], [280, 1335], [315, 1215], [340, 1080], [365, 990], [400, 935],
  [400, 1050], [405, 1150], [425, 1270], [455, 1355], [490, 1400], [520, 1395],
  [550, 1340], [575, 1245], [610, 1120], [650, 1000], [685, 925], [725, 880], [770, 850],
].map(([x, y]) => ({ x, y }));

function sample(corners: Point[]): Point[] {
  return corners.slice(1).flatMap((end, segment) => Array.from({ length: 16 }, (_, i) => ({
    x: corners[segment].x + (end.x - corners[segment].x) * i / 15,
    y: corners[segment].y + (end.y - corners[segment].y) * i / 15,
  })));
}

test("curved reference N opens notes without breaking straight N, C, or ordinary scrolling", () => {
  for (const scale of [0.2, 0.5, 1]) {
    assert.equal(recognizeCreationStroke(referenceN.map(p => ({ x: p.x * scale + 15, y: p.y * scale + 30 }))), "note");
  }
  assert.equal(recognizeCreationStroke(sample([{ x: 0, y: 200 }, { x: 0, y: 0 }, { x: 150, y: 200 }, { x: 150, y: 0 }])), "note");
  const rejected = [
    [...referenceN].reverse(),
    referenceN.slice(0, 14),
    sample([{ x: 0, y: 200 }, { x: 0, y: 0 }]),
    sample([{ x: 0, y: 200 }, { x: 150, y: 0 }]),
    sample([{ x: 0, y: 200 }, { x: 40, y: 0 }, { x: 65, y: 200 }, { x: 95, y: 0 }, { x: 125, y: 200 }, { x: 150, y: 0 }]),
  ];
  for (const stroke of rejected) assert.equal(recognizeCreationStroke(stroke), null);
  const arc = (start: number, sweep: number) => Array.from({ length: 41 }, (_, i) => ({ x: 190 + 80 * Math.cos(start + i * sweep / 40), y: 440 + 80 * Math.sin(start + i * sweep / 40) }));
  assert.equal(recognizeCreationStroke(arc(-Math.PI / 3, -4 * Math.PI / 3)), "conversation");
  assert.equal(recognizeCreationStroke(arc(0, 2 * Math.PI)), null);
});
