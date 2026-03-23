import { useEffect, useRef } from 'react';

/**
 * Subtle falling code rain canvas — decorative background for the connect page.
 *
 * Renders columns of faint code-like characters that scroll downward at varying
 * speeds, giving the impression of live code being streamed. Designed to sit
 * behind the glass-morphism card without competing for attention.
 */
export function CodeRain() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Code-like snippets that feel realistic
    const snippets = [
      'const ', 'let ', 'fn ', 'def ', 'import ', 'export ', 'return ',
      'async ', 'await ', 'if ', 'else ', 'for ', 'while ', 'match ',
      '=> ', '-> ', ':: ', '() ', '[] ', '{}', '..', '// ',
      'true', 'false', 'null', 'nil', 'self', 'this',
      'pub ', 'use ', 'mod ', 'impl ', 'trait ', 'type ',
      '<T>', 'Ok()', 'Err', 'Some', 'None',
      'println!', 'console.', 'print(', 'log(',
      '= ', '!= ', '== ', '>= ', '<= ', '&& ', '|| ',
      '0x', '127', '443', '8080', '3000',
      'utf-8', 'json', 'ssh', 'tcp', 'http',
      'fn main', 'class ', 'struct ', 'enum ',
      '.map(', '.filter(', '.then(', '.catch(',
      'Result<', 'Vec<', 'Option<', 'Promise<',
      '|> ', ':ok', ':error', 'defmodule ',
    ];

    /** Pick a random snippet */
    const randomSnippet = () => snippets[Math.floor(Math.random() * snippets.length)];

    // --- Column state ---

    interface Column {
      x: number;
      y: number;
      speed: number;        // px per frame
      opacity: number;      // base opacity for this column
      chars: string;        // current text being "typed"
      charIndex: number;    // how many chars revealed so far
      fontSize: number;
    }

    let columns: Column[] = [];
    let w = 0;
    let h = 0;
    let animId = 0;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      initColumns();
    };

    const initColumns = () => {
      const colGap = 26;                  // px between columns
      const count = Math.ceil(w / colGap);
      columns = Array.from({ length: count }, (_, i) => makeColumn(i * colGap, true));
    };

    const makeColumn = (x: number, randomizeY: boolean): Column => ({
      x,
      y: randomizeY ? Math.random() * h : -20,
      speed: 0.2 + Math.random() * 0.45,
      opacity: 0.08 + Math.random() * 0.12,
      chars: randomSnippet() + randomSnippet() + ' ' + randomSnippet(),
      charIndex: 0,
      fontSize: 10 + Math.floor(Math.random() * 3),
    });

    // --- Render loop ---

    const draw = () => {
      ctx.clearRect(0, 0, w, h);

      for (const col of columns) {
        ctx.font = `${col.fontSize}px "SF Mono", "Fira Code", "Cascadia Code", Menlo, Consolas, monospace`;

        // Draw each character vertically
        const lineH = col.fontSize + 4;
        const visible = col.chars.slice(0, Math.floor(col.charIndex));

        for (let j = 0; j < visible.length; j++) {
          // Fade trailing characters
          const distFromHead = visible.length - 1 - j;
          const fade = Math.max(0, 1 - distFromHead * 0.08);
          const alpha = col.opacity * fade;

          // Head character gets a brighter teal tint
          if (j === visible.length - 1) {
            ctx.fillStyle = `rgba(0, 220, 240, ${Math.min(alpha * 3, 0.5)})`;
          } else {
            ctx.fillStyle = `rgba(180, 200, 220, ${alpha})`;
          }

          ctx.fillText(visible[j], col.x, col.y + j * lineH);
        }

        // Advance "typing"
        col.charIndex += col.speed * 0.5;

        // Scroll downward
        col.y += col.speed;

        // Reset when off-screen
        if (col.y > h + 40) {
          col.y = -(col.chars.length * (col.fontSize + 4));
          col.chars = randomSnippet() + randomSnippet() + ' ' + randomSnippet();
          col.charIndex = 0;
          col.speed = 0.2 + Math.random() * 0.45;
          col.opacity = 0.08 + Math.random() * 0.12;
        }

        // When fully typed, get new text
        if (col.charIndex > col.chars.length + 6) {
          col.chars = randomSnippet() + randomSnippet() + ' ' + randomSnippet();
          col.charIndex = 0;
        }
      }

      animId = requestAnimationFrame(draw);
    };

    resize();
    animId = requestAnimationFrame(draw);

    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animId);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 0,
      }}
    />
  );
}
