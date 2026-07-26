# Receptor Google Cast de LA OCA BORRACHA

Esta carpeta es **solo la pantalla de televisión** del juego *La Oca Borracha*.

Un Chromecast no recibe imagen: recibe una dirección y se descarga él mismo la
página que va a mostrar. Por eso este receptor tiene que vivir en una URL
pública — la descarga el propio dispositivo, no el móvil.

**Aquí no hay nada del juego.** Ni reglas, ni retos, ni estadísticas, ni datos
de jugadores. Solo el HTML, el CSS y el JavaScript que pintan el tablero en la
tele, más las dos tipografías. El juego vive en otro sitio y es privado.

## Qué recibe de un móvil, y qué no

El móvil es la única autoridad. La tele solo recibe una proyección pública ya
saneada, por un único canal (`urn:x-cast:com.juegaoca.presentation`):
posiciones, turno, tirada, efectos públicos, ceremonias y, si se autoriza,
el texto del reto.

Nunca recibe porras sin revelar, decisiones secretas, anuncios, compras,
recuerdos, notas ni identificadores internos. Los nombres y los retos pueden
ocultarse desde el móvil en cualquier momento.

No hay emparejamiento por URL, QR, código ni relay, y no existe servidor
detrás: esto es una carpeta de ficheros estáticos.

## Ver cómo queda, sin Chromecast

```bash
python -m http.server 8080
```

- `http://localhost:8080/?demo=board`
- `http://localhost:8080/?demo=card`
- `http://localhost:8080/?demo=ceremony`
- `http://localhost:8080/?demo=victory`
- `http://localhost:8080/?demo=private`
- `http://localhost:8080/?demo=privacy`

Conviene revisarlo a 1280×720, 1920×1080 y 3840×2160.

## Pruebas

```bash
node protocol.test.js
node receiver_smoke.test.js
```

La primera valida sesiones, replay, saltos, snapshots reparadores, el esquema
de presentación y que solo mande un emisor. La segunda ejerce las vistas demo
y el receptor real sobre un CAF simulado (autoridad, ACK, reparación, límite
de 64 KB y rechazos), sin depender de un dispositivo Cast.

## Licencias

El código del receptor pertenece al proyecto La Oca Borracha.

Las tipografías **Alfa Slab One** y **Archivo** se redistribuyen bajo la SIL
Open Font License 1.1; el texto de cada licencia acompaña a los ficheros en
`assets/`.
