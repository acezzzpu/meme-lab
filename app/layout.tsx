import type {Metadata} from 'next';
import './globals.css';
export const metadata:Metadata={title:'MEME LAB · Trading research',description:'Investigación de traders, datos on-chain y ejecución controlada.'};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="es" className="dark"><body>{children}</body></html>;}
