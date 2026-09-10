import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/postcss';
import {resolve} from 'node:path';
export default defineConfig({plugins:[react()],resolve:{alias:{'@':resolve(import.meta.dirname,'.')}},build:{outDir:'standalone-dist',emptyOutDir:true},css:{postcss:{plugins:[tailwind()]}}});
