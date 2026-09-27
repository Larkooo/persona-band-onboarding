/** Avatar that echoes the band: a navy disc with the white LED ring, and the assistant's initial once it has a name. */
export function Orb({ name, size = 40, pulse = false }: { name: string | null; size?: number; pulse?: boolean }) {
  const initial = name?.trim().charAt(0).toUpperCase();
  return (
    <span className={`orb ${pulse ? "orb-pulse" : ""}`} style={{ width: size, height: size }} aria-hidden="true">
      <span className="orb-ring" />
      {initial && (
        <span className="orb-initial" style={{ fontSize: size * 0.36 }}>
          {initial}
        </span>
      )}
    </span>
  );
}
