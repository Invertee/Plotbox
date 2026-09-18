import { useEffect, useState } from 'react';
import { ProjectList } from './components/ProjectList';
import { Editor } from './components/Editor';

function currentProjectId(): string | undefined {
  return window.location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
}

export function App() {
  const [projectId, setProjectId] = useState(currentProjectId);
  useEffect(() => {
    const handler = () => setProjectId(currentProjectId());
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);
  const navigate = (path: string) => {
    window.history.pushState({}, '', path);
    setProjectId(currentProjectId());
  };
  return projectId ? <Editor projectId={projectId} onBack={() => navigate('/')} /> : <ProjectList onOpen={(id) => navigate(`/projects/${id}`)} />;
}
