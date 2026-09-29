import clsx from 'clsx';
import { cva } from 'class-variance-authority';

const badge = cva('inline-flex px-2 text-xs', {
  variants: { tone: { info: 'bg-blue-100 text-blue-800', warn: 'bg-yellow-100' } },
});

export function Button({ active, disabled, label }: any) {
  return (
    <div className="group flex items-center gap-2 p-4 md:p-8 card">
      <button
        className={clsx('px-4 py-2 rounded bg-blue-500 hover:bg-blue-600', active && 'ring-2 shadow-lg', { 'opacity-50 cursor-not-allowed': disabled })}
      >
        {label}
      </button>
      <span className={`text-sm font-bold ${active ? 'text-red-500' : 'text-gray-500'} dark:text-white`}>x</span>
      <i className="hidden group-hover:block animate-spin w-[calc(100%-2rem)]" />
      <span className={badge({ tone: 'info' })} />
    </div>
  );
}

export const Footer = () => <footer className="mt-4 space-x-2 translate-x-2">f</footer>;
