# Diagnóstico de la ruta BNB

1. Extraé `meme-lab-diagnostico-bnb.zip`.
2. Copiá su contenido dentro de tu carpeta actual de MEME LAB, junto a `Iniciar-MEME-LAB.cmd`.
3. Hacé doble clic en **Diagnosticar-Copy-BNB.cmd**. Podés dejar el bot abierto.
4. Esperá a que muestre “Diagnóstico guardado”. Adjuntá en el chat el archivo **diagnostico-bnb-…json** creado en esa misma carpeta.

Consulta el RPC público que aparece en el diagnóstico recibido. Comprueba el contrato de la primera pool de la venta de “lock in”, sus tokens, su factory y su registro, en estado actual e histórico. Además comprueba una de las consultas históricas de BNB nativo que falló con `missing trie node`.

No requiere pegar claves ni contraseñas. No abre `.env`, la base de datos, el token de administrador o la wallet. No modifica el motor ni envía operaciones. Solamente guarda el resultado de consultas públicas en un JSON nuevo.

Una consulta exitosa no habilita automáticamente una ruta para copiarla. Una factory diferente a Pancake requiere adaptar y verificar el protocolo de ejecución antes de autorizarlo.

El formato y los casos de error se prueban con respuestas controladas. Las consultas directas desde el entorno de desarrollo al RPC público agotaron el tiempo; por eso este diagnóstico debe ejecutarse en la PC donde el RPC está respondiendo.

Pruebas de la utilidad: 5 casos aprobados con respuestas controladas (factory distinta, registro incorrecto, cadena/ID inválido, movimientos nativos y RPC sin respuesta). El lanzador Windows no se ejecutó en este entorno.
