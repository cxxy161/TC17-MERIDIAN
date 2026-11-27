import React, { useId } from 'react';

export interface MeridianLogoProps {
  className?: string;
  framed?: boolean;
}

export const MeridianLogo: React.FC<MeridianLogoProps> = ({
  className = 'w-5 h-5',
  framed = false,
}) => {
  const gradId = useId();
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <radialGradient id={gradId} cx="36%" cy="32%" r="68%">
          <stop offset="0%" stopColor="#253b54" />
          <stop offset="65%" stopColor="#172333" />
          <stop offset="100%" stopColor="#0f1722" />
        </radialGradient>
      </defs>

      {framed && (
        <rect
          x="2"
          y="2"
          width="60"
          height="60"
          rx="14"
          fill="#161b22"
          stroke="#38bdf8"
          strokeOpacity="0.28"
          strokeWidth="1.5"
        />
      )}

      <g transform="rotate(-24 32 32)">
        <path
          d="M 8 32 A 24 8.8 0 0 1 56 32"
          fill="none"
          stroke="#38bdf8"
          strokeOpacity="0.34"
          strokeWidth="3.2"
          strokeLinecap="round"
        />
      </g>

      <circle cx="32" cy="32" r="13.5" fill={`url(#${gradId})`} stroke="#38bdf8" strokeWidth="3.4" />
      <line
        x1="32"
        y1="9.5"
        x2="32"
        y2="54.5"
        stroke="#e0f2fe"
        strokeWidth="2.8"
        strokeLinecap="round"
      />

      <g transform="rotate(-24 32 32)">
        <path
          d="M 8 32 A 24 8.8 0 0 0 56 32"
          fill="none"
          stroke="#38bdf8"
          strokeWidth="3.4"
          strokeLinecap="round"
        />
        {framed && <circle cx="50.5" cy="37.6" r="5.8" fill="#161b22" />}
        <circle cx="50.5" cy="37.6" r="3.8" fill="#fde68a" />
      </g>
    </svg>
  );
};
