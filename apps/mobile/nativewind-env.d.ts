/// <reference types="nativewind/types" />

// NativeWind's type shim declares `className` props but no ambient module for a
// CSS side-effect import; Metro resolves `import './global.css'` at bundle time,
// but tsc has no declaration for it. Supply one so `tsc --noEmit` typechecks.
declare module '*.css' {}
