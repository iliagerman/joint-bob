import assert from "node:assert/strict";
import test from "node:test";
import { qrMatrix } from "../public/app/qr.js";

const draw = (matrix: boolean[][]): string[] => matrix.map((row) => row.map((dark) => (dark ? "#" : ".")).join(""));

// Produced by macOS CoreImage's CIQRCodeGenerator at correction level M, border removed. An
// independent encoder choosing the same version, mask and bits shows the layout, Reed–Solomon
// codewords, format bits and mask penalty all follow the standard.
const HELLO = [
  "#######..##...#######",
  "#.....#.##....#.....#",
  "#.###.#..#.##.#.###.#",
  "#.###.#...##..#.###.#",
  "#.###.#.##..#.#.###.#",
  "#.....#.....#.#.....#",
  "#######.#.#.#.#######",
  "..........###........",
  "#.#.#.#..#.#....#..#.",
  "..#.##....#...#....##",
  ".#.#..#.###.#...#####",
  "##..#.........#....#.",
  ".##.#.##..#.#.#.#....",
  "........####.#.#..###",
  "#######...##.###..###",
  "#.....#...####.##....",
  "#.###.#.#.##.###...##",
  "#.###.#..#....##..##.",
  "#.###.#.###.#...#.#.#",
  "#.....#..#....#.#..#.",
  "#######.###.#.##...##",
];

const PHONE_ADDRESS = [
  "#######..#...#.#..###.#######",
  "#.....#..#.######.#...#.....#",
  "#.###.#.###.##.##...#.#.###.#",
  "#.###.#.#..##.#..#.#..#.###.#",
  "#.###.#.#..#....##.##.#.###.#",
  "#.....#.#.##...##.#.#.#.....#",
  "#######.#.#.#.#.#.#.#.#######",
  "........###.#.#.#...#........",
  "#.#####..#..#....##...#####..",
  "##.#...#..#..##.#####.###...#",
  "#.###.##.....#####...#.##....",
  ".#........#..#....##..##.#.#.",
  ".#.####...###.##.#..#....##..",
  ".##....#...#....#.###.#.#...#",
  ".##..##.....#..#.......#.##..",
  ".....#.##.##..#.#..###..#..#.",
  "..##.####..#.....#.#.....##..",
  "#..###.#.#.####..#.#..###.#.#",
  "#.....##..#.#####.#.#..##.#..",
  "#.##...##.#..#.##.###...#..#.",
  "#..#.##..#.#..##.#.######.###",
  "........###.....#.#.#...#####",
  "#######..#.##..#..###.#.###..",
  "#.....#.####..###..##...#..#.",
  "#.###.#.#.#......#..#####.#..",
  "#.###.#.#..#.##.####.....####",
  "#.###.#.#..##.##....########.",
  "#.....#..##...##....#..###.#.",
  "#######.#...######.#.#.#..#..",
];

test("QR codes match an independent encoder module for module", () => {
  assert.deepEqual(draw(qrMatrix("hello")), HELLO, "version 1");
  assert.deepEqual(draw(qrMatrix("https://mac-studio.relay.example.com")), PHONE_ADDRESS, "version 3, the size of a typical phone address");
});

test("QR codes use the smallest version that holds the text", () => {
  const version = (text: string): number => (qrMatrix(text).length - 17) / 4;
  assert.equal(version(""), 1);
  assert.equal(version("x".repeat(14)), 1, "14 bytes is version 1's limit at level M");
  assert.equal(version("x".repeat(15)), 2);
  assert.equal(version("x".repeat(213)), 10, "version 10 needs a 16-bit length field");
  assert.equal(version("x".repeat(2331)), 40);
  assert.equal(version("é".repeat(7)), 1, "text is counted in UTF-8 bytes");
  assert.equal(version("é".repeat(8)), 2);
  assert.throws(() => qrMatrix("x".repeat(2332)), RangeError);
});

test("QR codes from version 7 carry the version in both corners", () => {
  const matrix = qrMatrix("x".repeat(110));
  const size = matrix.length;
  assert.equal(size, 45, "version 7");
  let topRight = 0;
  let bottomLeft = 0;
  for (let i = 0; i < 18; i += 1) {
    if (matrix[Math.floor(i / 3)][size - 11 + (i % 3)]) topRight |= 1 << i;
    if (matrix[size - 11 + (i % 3)][Math.floor(i / 3)]) bottomLeft |= 1 << i;
  }
  // Version 7's 18-bit version information from the standard's table.
  assert.equal(topRight, 0x07c94);
  assert.equal(bottomLeft, 0x07c94);
});
