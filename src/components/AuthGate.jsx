import React, { useState } from 'react';
import LoginScreen from './LoginScreen';
import App from '../App.jsx';
import { isAuthenticated } from '../services/authApi';

// Gate de autenticação: sem sessão válida, mostra a tela de login; com sessão,
// renderiza o app. O 401 nas chamadas de API dispara logout + reload (authApi),
// então o gate volta a exibir o login automaticamente.
export default function AuthGate() {
  const [authed, setAuthed] = useState(isAuthenticated());

  if (!authed) {
    return <LoginScreen onSuccess={() => setAuthed(true)} />;
  }
  return <App />;
}
