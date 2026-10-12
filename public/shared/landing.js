// The landing page's only script: the light/dark switch.
import { mountThemeSwitch } from './theme.js';

const slot = document.getElementById('theme-switch');
if (slot) mountThemeSwitch(slot, { getLang: () => 'en' });
