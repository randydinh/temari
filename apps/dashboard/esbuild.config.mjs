import { packageManagedWorkflow } from './scripts/package-workflow.mjs';

export default {
  outExtension: { '.js': '.mjs' },
  plugins: [
    {
      name: 'package-managed-workflow',
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors.length === 0)
            await packageManagedWorkflow('apps/dashboard/dist/workflow-host');
        });
      },
    },
  ],
};
