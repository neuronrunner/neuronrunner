'use client';

import React, { useEffect, useRef } from "react";
import { useTheme } from "next-themes";

interface DataPacket {
  x: number;
  y: number;
  dx: number;
  dy: number;
  length: number;
  opacity: number;
}

interface Ripple {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  speed: number;
  opacity: number;
}

export default function Background() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { theme, resolvedTheme } = useTheme();
  // Safe default to avoid SSR mismatch, updated on mount
  const currentTheme = resolvedTheme || theme || "dark";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animationFrameId: number;
    let packets: DataPacket[] = [];
    let ripples: Ripple[] = [];
    const gridSpacing = 40; // spacing in pixels for the compute grid
    
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    let width = window.innerWidth;
    let height = window.innerHeight;

    let rawMouseX = -1000;
    let rawMouseY = -1000;

    const initCanvas = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      
      ctx.scale(dpr, dpr);
      packets = [];
      ripples = [];
    };

    const handleMouseMove = (e: MouseEvent) => {
      rawMouseX = e.clientX;
      rawMouseY = e.clientY;
    };

    const handleMouseLeave = () => {
      rawMouseX = -1000;
      rawMouseY = -1000;
    };

    const handleClick = (e: MouseEvent) => {
      // Spawn a ripple wave at click coordinates
      ripples.push({
        x: e.clientX,
        y: e.clientY,
        radius: 0,
        maxRadius: 280,
        speed: 3.5,
        opacity: 0.5,
      });
    };

    if (typeof window !== "undefined") {
      window.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseleave", handleMouseLeave);
      window.addEventListener("click", handleClick);
    }

    const createPacket = () => {
      if (currentTheme !== "dark") return; // Keep light mode completely static and clean
      if (packets.length >= 12) return; // Allow slightly more packets for vivacity

      const horizontal = Math.random() < 0.5;
      const speed = Math.random() * 1.5 + 1.2; // Slow, elegant speed
      const length = Math.random() * 80 + 40;
      
      if (horizontal) {
        const fromLeft = Math.random() < 0.5;
        const gridY = Math.floor(Math.random() * (height / gridSpacing)) * gridSpacing;
        packets.push({
          x: fromLeft ? -length : width + length,
          y: gridY,
          dx: fromLeft ? speed : -speed,
          dy: 0,
          length,
          opacity: Math.random() * 0.25 + 0.25,
        });
      } else {
        const fromTop = Math.random() < 0.5;
        const gridX = Math.floor(Math.random() * (width / gridSpacing)) * gridSpacing;
        packets.push({
          x: gridX,
          y: fromTop ? -length : height + length,
          dx: 0,
          dy: fromTop ? speed : -speed,
          length,
          opacity: Math.random() * 0.25 + 0.25,
        });
      }
    };

    const drawPackets = () => {
      for (let i = packets.length - 1; i >= 0; i--) {
        const p = packets[i];
        p.x += p.dx;
        p.y += p.dy;

        const isOut = p.dx > 0 ? p.x > width + p.length : 
                      p.dx < 0 ? p.x < -p.length : 
                      p.dy > 0 ? p.y > height + p.length : 
                      p.y < -p.length;

        if (isOut) {
          packets.splice(i, 1);
          continue;
        }

        const xStart = p.x;
        const yStart = p.y;
        const xEnd = p.x - p.dx * (p.length / Math.hypot(p.dx, p.dy));
        const yEnd = p.y - p.dy * (p.length / Math.hypot(p.dx, p.dy));

        const grad = ctx.createLinearGradient(xStart, yStart, xEnd, yEnd);
        // Subtle soft off-white tracer gradient
        grad.addColorStop(0, `rgba(228, 228, 231, ${p.opacity * 0.7})`);
        grad.addColorStop(0.4, `rgba(212, 212, 216, ${p.opacity * 0.3})`);
        grad.addColorStop(1, `rgba(212, 212, 216, 0)`);

        ctx.beginPath();
        ctx.moveTo(xStart, yStart);
        ctx.lineTo(xEnd, yEnd);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1.0;
        ctx.stroke();
      }
    };

    const animate = () => {
      ctx.clearRect(0, 0, width, height);
      const isDark = currentTheme === "dark";

      // 1. Draw coordinate grid lines
      ctx.strokeStyle = isDark ? "rgba(255, 255, 255, 0.015)" : "rgba(0, 0, 0, 0.02)";
      ctx.lineWidth = 0.8;
      
      // Vertical grid lines
      for (let x = 0; x < width; x += gridSpacing) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      
      // Horizontal grid lines
      for (let y = 0; y < height; y += gridSpacing) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      // 2. Draw/Update ripples
      for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i];
        r.radius += r.speed;
        r.opacity = 1 - r.radius / r.maxRadius;

        if (r.radius >= r.maxRadius) {
          ripples.splice(i, 1);
          continue;
        }

        ctx.beginPath();
        ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
        ctx.strokeStyle = isDark
          ? `rgba(228, 228, 231, ${r.opacity * 0.1})`
          : `rgba(0, 0, 0, ${r.opacity * 0.05})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // 3. Draw junction dots with hover and ripple glows
      const maxProximity = 120;
      
      for (let x = 0; x < width; x += gridSpacing) {
        for (let y = 0; y < height; y += gridSpacing) {
          const distToMouse = Math.hypot(x - rawMouseX, y - rawMouseY);
          
          // Calculate intersection with ripples
          let rippleGlow = 0;
          for (const ripple of ripples) {
            const d = Math.hypot(x - ripple.x, y - ripple.y);
            if (d < ripple.radius + 20 && d > ripple.radius - 20) {
              const diff = Math.abs(d - ripple.radius);
              rippleGlow += (1 - diff / 20) * ripple.opacity;
            }
          }
          rippleGlow = Math.min(rippleGlow, 1.0);

          if (distToMouse < maxProximity || rippleGlow > 0) {
            const proximityFactor = distToMouse < maxProximity ? (1 - distToMouse / maxProximity) : 0;
            
            // Draw a halo under hover or ripple glow
            ctx.beginPath();
            ctx.arc(x, y, 5 + proximityFactor * 7 + rippleGlow * 3.5, 0, Math.PI * 2);
            ctx.fillStyle = isDark 
              ? `rgba(228, 228, 231, ${proximityFactor * 0.05 + rippleGlow * 0.06})`
              : `rgba(0, 0, 0, ${proximityFactor * 0.03 + rippleGlow * 0.04})`;
            ctx.fill();
            
            // Brighten dot
            ctx.fillStyle = isDark
              ? `rgba(228, 228, 231, ${0.04 + proximityFactor * 0.15 + rippleGlow * 0.25})`
              : `rgba(0, 0, 0, ${0.05 + proximityFactor * 0.12 + rippleGlow * 0.2})`;
          } else {
            ctx.fillStyle = isDark ? "rgba(255, 255, 255, 0.03)" : "rgba(0, 0, 0, 0.04)";
          }

          // Small junction squares
          ctx.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
        }
      }

      // 4. Draw linear compute drift packets
      if (isDark && Math.random() < 0.02) {
        createPacket();
      }
      drawPackets();

      animationFrameId = requestAnimationFrame(animate);
    };

    initCanvas();
    animate();

    const handleResize = () => {
      initCanvas();
    };

    window.addEventListener("resize", handleResize);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener("resize", handleResize);
      if (typeof window !== "undefined") {
        window.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseleave", handleMouseLeave);
        window.removeEventListener("click", handleClick);
      }
    };
  }, [currentTheme]);

  return (
    <div
      className="fixed inset-0 pointer-events-none z-0 overflow-hidden"
      style={{
        backgroundColor: currentTheme === "dark" ? "#050508" : "#f9fafb",
        transition: "background-color 0.8s ease",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          width: "100%",
          height: "100%",
        }}
      />
    </div>
  );
}
