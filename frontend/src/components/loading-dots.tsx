export const LoadingDots = () => {
  return (
    <div className="inline-flex items-center gap-1.5 py-1" aria-label="Loading">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-muted-foreground/75 animate-pulse"
          style={{
            animationDuration: "1.1s",
            animationDelay: `${i * 0.2}s`,
          }}
        />
      ))}
    </div>
  );
};
