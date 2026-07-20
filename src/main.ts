import './style.css';
import { Simulation } from './sim/simulation';
import { Renderer } from './render/renderer';
import { ControlPanel } from './ui/panel';

const canvas = document.querySelector<HTMLCanvasElement>('#view');
const panelRoot = document.querySelector<HTMLElement>('#panel');
if (!canvas || !panelRoot) throw new Error('missing #view or #panel in the document');

const sim = new Simulation(2);
const renderer = new Renderer(canvas, sim);
const panel = new ControlPanel(panelRoot, sim);

window.addEventListener('resize', () => renderer.resize());
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    panel.togglePlay();
  }
});

let last = performance.now();

function frame(now: number): void {
  const dt = (now - last) / 1000;
  last = now;

  sim.advance(dt); // simulate
  renderer.draw(); // then draw — never the other way round
  panel.update();

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
