import React, { useState } from 'react';
import LoginScreen from './LoginScreen';
import App from '../App.jsx';
import { isAuthenticated } from '../services/authApi';
import { ToastProvider } from './ui/ToastProvider';
import { ConfirmProvider } from './ui/ConfirmProvider';

// Gate de autenticação: sem sessão válida, mostra a tela de login; com sessão,
// renderiza o app dentro dos providers de toast/confirmação.
export default function AuthGate() {
  const [authed, setAuthed] = useState(isAuthenticated());

  if (!authed) {
    return <LoginScreen onSuccess={() => setAuthed(true)} />;
  }
  return (
    <ToastProvider>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </ToastProvider>
  );
}
