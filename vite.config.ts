import { defineConfig } from 'vite';

// Relative asset URLs so a production build loads on a GitHub Pages project
// site (https://<user>.github.io/<repo>/) and from `vite preview`.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? './' : '/',
}));
