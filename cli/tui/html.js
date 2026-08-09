// cli/tui/html.js — the one piece of glue that lets us write Ink UIs with JSX-like
// syntax but no build step. htm turns tagged-template markup into React.createElement
// calls at runtime.
//
// Gotcha htm has by design: a *bare* capitalized tag like `<Box>` is parsed as the
// string "Box", not the imported Box component. So we bind htm to a wrapper that maps the
// Ink tag names we use to the real components. Everything else (interpolated components
// like `<${Spinner}/>`, lowercase tags) passes straight through.

import { createElement } from "react";
import htm from "htm";
import { Box, Text, Static } from "ink";

const TAGS = { Box, Text, Static };
const h = (type, props, ...children) =>
  createElement(typeof type === "string" && TAGS[type] ? TAGS[type] : type, props, ...children);

export const html = htm.bind(h);
