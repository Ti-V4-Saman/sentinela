import * as React from 'react';
import { Mic, Image as ImageIcon, Video, FileText, MessageSquare, HelpCircle } from 'lucide-react';

// Metadados por tipo de mensagem. O schema atual NÃO guarda URL de mídia, então
// mídia é representada por ícone + rótulo + legenda/transcrição (quando houver).
export const TYPE_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; media: boolean }> = {
  text: { label: 'Texto', icon: MessageSquare, media: false },
  audio: { label: 'Áudio', icon: Mic, media: true },
  image: { label: 'Imagem', icon: ImageIcon, media: true },
  video: { label: 'Vídeo', icon: Video, media: true },
  document: { label: 'Documento', icon: FileText, media: true },
};

export function typeMeta(type?: string) {
  return (type && TYPE_META[type]) || { label: type || 'Mensagem', icon: HelpCircle, media: false };
}

// Conteúdo de uma mensagem dentro do balão.
export function MessageContent({ type, text }: { type?: string; text?: string | null }) {
  const meta = typeMeta(type);
  const Icon = meta.icon;
  const content = (text || '').trim();

  if (!meta.media) {
    // texto / desconhecido: mostra o texto; se vazio, um placeholder discreto.
    return content
      ? <p className="whitespace-pre-wrap break-words text-sm">{content}</p>
      : <p className="text-sm italic text-muted-foreground">Mensagem sem conteúdo.</p>;
  }

  // Mídia (áudio/imagem/vídeo/documento): sem prévia disponível no schema atual.
  const isAudio = type === 'audio';
  return (
    <div className="space-y-1">
      <span className="inline-flex items-center gap-1.5 rounded-md bg-foreground/5 px-2 py-1 text-xs font-medium">
        <Icon className="h-3.5 w-3.5" /> {meta.label}
        <span className="text-muted-foreground">· sem prévia</span>
      </span>
      {content && (
        isAudio
          ? <p className="whitespace-pre-wrap break-words text-sm"><span className="mr-1 text-[11px] uppercase tracking-wide text-muted-foreground">transcrição:</span>{content}</p>
          : <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{content}</p>
      )}
      {!content && isAudio && <p className="text-xs italic text-muted-foreground">Sem transcrição.</p>}
    </div>
  );
}
