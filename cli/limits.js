// cli/limits.js — hard limits shared by input validation and the run loop.

// Upper bound for a run's steps, including any "add more steps?" extensions. Each step is
// roughly one vision API call, so an unbounded value is a real (and easily fat-fingered)
// bill; --steps above this is refused, and extensions stop at it.
export const MAX_STEPS = 100;
