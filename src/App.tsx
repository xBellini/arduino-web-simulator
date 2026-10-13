/**
 * What: Root layout shell — SimProvider + workspace grid. Default export App; mounts Toolbar, then workspace
 * with Palette | canvas-column (SimCanvas) | IdePanel. All shared state enters via SimProvider (store/SimContext).
 * Class names .app / .workspace / .canvas-column match index.css flex layout. To add a new top-level panel:
 * import component, insert in JSX here, add layout rules in index.css. Avoid business logic in App — wire through
 * context or child components. Entry bootstrap and global CSS import: main.tsx — not App.
 *
# Changelog
# Date       | Author | Remarks
# 17-09-2026 | Cursor | Changelog creation
#                     | Expanded What with practical how-to notes
 */
import { Palette } from './ui/palette/Palette';
import { SimCanvas } from './ui/canvas/SimCanvas';
import { IdePanel } from './ui/ide/IdePanel';
import { Toolbar } from './ui/Toolbar';
import { SimProvider } from './store/SimContext';

export default function App() {
  return (
    <SimProvider>
      <div className="app">
        <Toolbar />
        <div className="workspace">
          <Palette />
          <div className="canvas-column">
            <SimCanvas />
          </div>
          <IdePanel />
        </div>
      </div>
    </SimProvider>
  );
}
