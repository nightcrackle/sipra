import { useState } from 'react';

import { countByFolder, sortedFolders, trashCount } from '@shared/library';

import { FolderIcon, PlusIcon, SearchIcon, TrashIcon } from './Icons';
import { useStore } from '../state/store';

/**
 * Folders, search and trash.
 *
 * Folders are drop targets: dragging a track card onto one files it. The
 * drag payload is a plain list of track ids, set by `TrackCard`.
 */
export function Sidebar(): JSX.Element {
  const library = useStore((state) => state.library);
  const folderId = useStore((state) => state.folderId);
  const scope = useStore((state) => state.scope);
  const searchText = useStore((state) => state.searchText);
  const setFolder = useStore((state) => state.setFolder);
  const setScope = useStore((state) => state.setScope);
  const setSearchText = useStore((state) => state.setSearchText);
  const pushNotice = useStore((state) => state.pushNotice);

  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const counts = countByFolder(library);
  const folders = sortedFolders(library);
  const trashed = trashCount(library);

  const dropTracks = async (targetFolderId: string | null, event: React.DragEvent): Promise<void> => {
    event.preventDefault();
    setDropTarget(null);
    const raw = event.dataTransfer.getData('application/x-sipra-tracks');
    if (!raw) return;
    try {
      const ids = JSON.parse(raw) as string[];
      if (!Array.isArray(ids) || ids.length === 0) return;
      await window.sipra.library.moveTracks(ids, targetFolderId);
    } catch {
      pushNotice({ level: 'error', title: 'Move failed', message: 'Those tracks could not be moved.' });
    }
  };

  const createFolder = async (): Promise<void> => {
    const { folder } = await window.sipra.library.createFolder('New folder');
    setRenamingId(folder.id);
    setRenameValue(folder.name);
  };

  const commitRename = async (id: string): Promise<void> => {
    const name = renameValue.trim();
    setRenamingId(null);
    if (name) await window.sipra.library.renameFolder(id, name);
  };

  const removeFolder = async (id: string, name: string): Promise<void> => {
    await window.sipra.library.deleteFolder(id);
    if (folderId === id) setFolder(undefined);
    pushNotice({
      level: 'info',
      title: `Deleted "${name}"`,
      message: 'The tracks that were in it are still in your library, now unfiled.',
    });
  };

  const isActive = (candidate: string | null | undefined): boolean =>
    scope === 'live' && folderId === candidate;

  return (
    <nav className="sidebar" aria-label="Library">
      <div className="search">
        <SearchIcon size={14} className="search__icon" />
        <input
          className="search__input"
          type="search"
          value={searchText}
          placeholder="Search title, key, BPM…"
          onChange={(event) => setSearchText(event.target.value)}
          aria-label="Search the library"
        />
        {searchText ? (
          <button
            type="button"
            className="search__clear"
            onClick={() => setSearchText('')}
            aria-label="Clear search"
          >
            ×
          </button>
        ) : null}
      </div>

      <div className="sidebar__section">
        <button
          type="button"
          className={`folder${isActive(undefined) ? ' is-active' : ''}`}
          onClick={() => {
            setScope('live');
            setFolder(undefined);
          }}
        >
          <FolderIcon size={15} />
          <span className="folder__name">All tracks</span>
          <span className="folder__count">
            {library.tracks.filter((track) => track.deletedAt === null).length}
          </span>
        </button>

        <button
          type="button"
          className={`folder${isActive(null) ? ' is-active' : ''}${
            dropTarget === '__unfiled__' ? ' is-drop-target' : ''
          }`}
          onClick={() => {
            setScope('live');
            setFolder(null);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDropTarget('__unfiled__');
          }}
          onDragLeave={() => setDropTarget(null)}
          onDrop={(event) => void dropTracks(null, event)}
        >
          <FolderIcon size={15} />
          <span className="folder__name">Unfiled</span>
          <span className="folder__count">{counts.__unfiled__ ?? 0}</span>
        </button>
      </div>

      <div className="sidebar__section grow" style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="sidebar__heading">
          <span>Folders</span>
          <button
            type="button"
            className="btn btn--ghost btn--icon btn--sm"
            onClick={() => void createFolder()}
            aria-label="New folder"
            title="New folder"
          >
            <PlusIcon size={13} />
          </button>
        </div>

        <div className="sidebar__list">
          {folders.length === 0 ? (
            <p className="field__hint" style={{ padding: '4px 8px' }}>
              No folders yet. Create one, then drag tracks onto it.
            </p>
          ) : null}

          {folders.map((folder) => (
            <div
              key={folder.id}
              className={`folder${isActive(folder.id) ? ' is-active' : ''}${
                dropTarget === folder.id ? ' is-drop-target' : ''
              }`}
              onDragOver={(event) => {
                event.preventDefault();
                setDropTarget(folder.id);
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(event) => void dropTracks(folder.id, event)}
              onDoubleClick={() => {
                setRenamingId(folder.id);
                setRenameValue(folder.name);
              }}
              role="button"
              tabIndex={0}
              onClick={() => {
                setScope('live');
                setFolder(folder.id);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  setScope('live');
                  setFolder(folder.id);
                }
              }}
            >
              <FolderIcon size={15} />
              {renamingId === folder.id ? (
                <input
                  className="folder__rename"
                  value={renameValue}
                  autoFocus
                  onChange={(event) => setRenameValue(event.target.value)}
                  onBlur={() => void commitRename(folder.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void commitRename(folder.id);
                    if (event.key === 'Escape') setRenamingId(null);
                  }}
                  onClick={(event) => event.stopPropagation()}
                />
              ) : (
                <>
                  <span className="folder__name">{folder.name}</span>
                  <span className="folder__count">{counts[folder.id] ?? 0}</span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--icon btn--sm"
                    onClick={(event) => {
                      event.stopPropagation();
                      void removeFolder(folder.id, folder.name);
                    }}
                    aria-label={`Delete folder ${folder.name}`}
                    title="Delete folder (tracks are kept)"
                  >
                    ×
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="sidebar__section">
        <button
          type="button"
          className={`folder${scope === 'trash' ? ' is-active' : ''}`}
          onClick={() => setScope('trash')}
        >
          <TrashIcon size={15} />
          <span className="folder__name">Trash</span>
          <span className="folder__count">{trashed}</span>
        </button>
      </div>
    </nav>
  );
}

export default Sidebar;
