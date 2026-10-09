// dom-to-svg + src/inpage/vector.ts → dist/inpage/vector.iife.js (evaluated in pages for the SVG versions).
import { buildVectorBundle } from '../dist/capture/vector.js';

await buildVectorBundle(true);
