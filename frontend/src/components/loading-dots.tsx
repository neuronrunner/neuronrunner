export const LoadingDots = () => {
  return (
    <div className="flex items-center gap-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-2 h-2 rounded-full bg-current animate-bounce"
          style={{
            animationDuration: "1s",
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </div>
  );
};
