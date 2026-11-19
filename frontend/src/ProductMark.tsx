export default function ProductMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg width="30" height="30" viewBox="0 0 32 32" fill="none" focusable="false">
        <path d="M17 16 28 6v20Z" fill="#f4b275" opacity=".2" />
        <path d="m4 24 5-7 5 3 4-6" stroke="#eef5fa" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
        <path d="m18 14 10-5M18 14l10 8" stroke="#f4b275" strokeWidth="1.4" strokeLinecap="round" strokeDasharray="2 3" />
        <path d="m18 14 10 1" stroke="#f4b275" strokeWidth="2.3" strokeLinecap="round" />
        <circle cx="18" cy="14" r="2.3" fill="#eef5fa" />
      </svg>
    </span>
  );
}
