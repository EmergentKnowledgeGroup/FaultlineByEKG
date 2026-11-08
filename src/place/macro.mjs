// Macro arrangement: where each stage block sits on the block grid, and whether it is mirrored. The implementation is the snake arrangement
// (snake.mjs): stage order is the strong prior, the snake is broken only where a swap saves a lot.
//   arrangeBlocks(blocks, links, opts) -> { cell, fh, fv, GC, GR, spread, cost, W, H, asp, snake, alternatives }
export { arrangeBlocks, snakeShapes } from './snake.mjs';
