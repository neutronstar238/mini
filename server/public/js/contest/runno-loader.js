/* ES Module 加载器：从自托管的 Runno runtime 导入 headlessRunCode，暴露给全局。
 * 必须以 <script type="module"> 引入；页面需 COOP/COEP 头（cross-origin isolated）。 */
import { headlessRunCode, stripWhitespace } from '/js/runno/runno-runtime.js';

window.__RUNNO__ = {
  headlessRunCode,
  stripWhitespace
};
window.dispatchEvent(new CustomEvent('runno-ready'));
