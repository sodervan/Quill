import React, { useState } from 'react';
import { Image, Text } from 'react-native';

export function faviconUri(urlOrDomain: string): string {
  try {
    const hostname = urlOrDomain.includes('://') ? new URL(urlOrDomain).hostname : urlOrDomain;
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=64`;
  } catch { return ''; }
}

export function FaviconAvatar({
  feedUrl, emoji, size = 52, borderRadius,
}: {
  feedUrl: string;
  emoji: string;
  size?: number;
  borderRadius?: number;
}) {
  const [failed, setFailed] = useState(false);
  const uri = faviconUri(feedUrl);
  const br = borderRadius ?? size / 2;
  if (uri && !failed) {
    return (
      <Image
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: br }}
        onError={() => setFailed(true)}
      />
    );
  }
  return <Text style={{ fontSize: size * 0.48, lineHeight: size }}>{emoji}</Text>;
}
