import { render } from 'preact';
import { initApp, listenToHost } from './actions';
import { App } from './App';
import './styles.css';

listenToHost();
render(<App />, document.getElementById('app')!);
void initApp();
