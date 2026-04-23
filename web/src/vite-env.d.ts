/// <reference types="vite/client" />

export {};

declare global {
  interface Window {
    __nb?: {
      simulateError?: (message: string) => void;
    };
  }
}
