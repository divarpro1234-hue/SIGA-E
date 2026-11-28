import { QRCodeSVG } from 'qrcode.react';

export function ImagenCodigoQR({ value, title }: { value: string; title: string }) {
  return (
    <QRCodeSVG
      value={value}
      size={240}
      level="M"
      includeMargin
      bgColor="#ffffff"
      fgColor="#000000"
      title={title}
    />
  );
}
