import {spawnSync} from 'node:child_process';
const r=spawnSync('python3',['-c',`import pathlib,zipfile
root=pathlib.Path('.')
allowed=['app','core','runtime','components','hooks','lib','db','drizzle','tests','docs','vendor','build','scripts','deploy']
files=[]
for folder in allowed:
 files.extend(p for p in (root/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts)
for name in ['README.md','package.json','package-lock.json','Dockerfile','render.yaml','compose.yaml','compose.production.yaml','compose.copy-live.yaml','Iniciar-MEME-LAB.cmd','Diagnosticar-Copy-BNB.cmd','.env.production.example','.dockerignore','.gitignore','.env.example','index.html','vite.standalone.ts','tsconfig.json','postcss.config.mjs','next.config.ts','components.json']:
 p=root/name
 if p.exists():files.append(p)
with zipfile.ZipFile('public/meme-lab-source.zip','w',zipfile.ZIP_DEFLATED) as z:
 for p in files:z.write(p,'meme-lab/'+p.as_posix())
print('Source package created:',len(files),'files')`],{stdio:'inherit'});process.exit(r.status??1);
