import React from 'react';
import Icon from '../Icon.tsx';
import type { UploadRef } from '../../types.ts';
import './attachments.css';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const IMAGE_MAX = 5 * 1024 * 1024;
export const FILE_MAX = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
// what a message that only carries files says, the server's FILES_ONLY
export const FILES_ONLY = 'See the attached files.';

export const isImage = (mimeType: string) => IMAGE_TYPES.includes(mimeType);
export const sizeOf = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`);
export const uploadSrc = (id: string) => `/api/uploads/${encodeURIComponent(id)}`;
export const fileProblem = (f: File) =>
  !f.size ? 'empty file' : isImage(f.type) ? (f.size > IMAGE_MAX ? `images up to ${sizeOf(IMAGE_MAX)}` : null) : f.size > FILE_MAX ? `files up to ${sizeOf(FILE_MAX)}` : null;

// the files a sent message carried: thumbnails open the image, chips download the file
export function SentFiles({ files }: { files: UploadRef[] }) {
  return (
    <div className="dp-upl-list">
      {files.map((f) =>
        isImage(f.mimeType) ? (
          <a key={f.id} className="dp-upl-img" href={uploadSrc(f.id)} target="_blank" rel="noreferrer" title={`${f.fileName} · ${sizeOf(f.size)}`}>
            <img src={uploadSrc(f.id)} alt={f.fileName} />
          </a>
        ) : (
          <a key={f.id} className="dp-upl-chip" href={uploadSrc(f.id)} download={f.fileName} title={f.fileName}>
            <Icon name="file" size={14} />
            <span className="dp-ell">{f.fileName}</span>
            <span className="dp-t3 dp-num">{sizeOf(f.size)}</span>
          </a>
        ),
      )}
    </div>
  );
}
